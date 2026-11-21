import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "../src/db/migrate.js";
import { agentLogs, jobs, pendingAsync, reminders, wakes, watches } from "../src/db/schema.js";
import { reportLostAsync } from "../src/runtime/async.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { pendingItems } from "../src/runtime/pending.js";
import { recordPendingWatch } from "../src/runtime/watches.js";
import { yieldReminder } from "../src/runtime/yield-reminder.js";
import type { DwarChatRequest } from "../src/types/domain.js";
import { deliverAgentMessage, deliverUserMessage } from "../src/runtime/deliver.js";
import {
  insertAgent,
  mockDwar,
  mockGhar,
  mockNas,
  mockYaad,
  openTestDb,
  resetRuntime,
  silentLog,
  testConfig,
  toolUse,
  yieldTurn,
} from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

function harness(opts: { agent?: (request: DwarChatRequest) => ReturnType<typeof yieldTurn> } = {}) {
  const nas = mockNas({});
  const yaad = mockYaad({
    ingest: async () => ({ counts: { create_node: 1, update_node: 0, close_node: 0, create_edge: 0, close_edge: 0, noop: 0 }, operations: [] }),
  });
  const dwar = mockDwar({ agent: opts.agent ?? (() => yieldTurn()) });
  const runtime = createRuntime({ db: handle.db, dwar, yaad, ghar: mockGhar(), nas, config, log: silentLog });
  return { nas, dwar, yaad, runtime };
}

const call = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });

/** Delivery that runs no agent, so a test sets the scene without a wake racing it. */
function quiet(runtime: ReturnType<typeof harness>["runtime"]) {
  return { ...runtime.deliver, enqueue: () => randomUUID(), preempt: () => {} };
}

/** An agent holding the open job `requester`, another agent, gave it, and a tool context standing in that job. */
async function inAgentJob(runtime: ReturnType<typeof harness>["runtime"], agentId: string, requester: string, words = "when is my exam?") {
  await deliverAgentMessage(quiet(runtime), { fromAgentId: requester, toAgentId: agentId, content: words });
  const [job] = await handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
  return { job: job!, ctx: { ...runtime.toolContext(agentId), jobId: job!.id } };
}

/** An agent holding Ankur's open job, and a tool context standing in that job. */
async function inJob(runtime: ReturnType<typeof harness>["runtime"], agentId: string, words = "when is my exam?") {
  await deliverUserMessage(quiet(runtime), agentId, words);
  const [job] = await handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
  return { job: job!, ctx: { ...runtime.toolContext(agentId), jobId: job!.id } };
}

test("ingest_memory returns what Yaad stored in the call, and a failure comes back as an error with nothing left pending", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "remember", systemPrompt: "remembers" });
  const { runtime, yaad } = harness();

  const stored = await executeTool(runtime.toolContext("remember"), call("ing-1", "ingest_memory", { text: "Ankur likes tea." }));
  assert.equal(stored.isError, false);
  assert.equal(JSON.parse(stored.content).counts.create_node, 1);
  assert.equal(yaad.ingestCalls.length, 1);

  yaad.ingest = async () => {
    throw new Error("yaad exploded");
  };
  const failed = await executeTool(runtime.toolContext("remember"), call("ing-2", "ingest_memory", { text: "x" }));
  assert.equal(failed.isError, true);
  assert.equal((await handle.db.select().from(pendingAsync)).length, 0);
});

test("a call a restart cut short is reported lost at boot, and the agent wakes for it", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "remember", systemPrompt: "remembers" });
  const { runtime, dwar } = harness();
  await handle.db.insert(pendingAsync).values({ id: "ing-3", agentId: "remember", toolName: "control_device" });

  const lost = await reportLostAsync(runtime.deliver);
  await runtime.waitUntilIdle();

  assert.equal(lost, 1);
  assert.match(runtime.transcript.transcriptFor("remember").at(-1)!.content, /^Result of control_device \(ing-3\) lost: hath restarted/);
  assert.equal(dwar.agentCalls.length, 1);
  assert.equal((await handle.db.select().from(pendingAsync)).length, 0);
});

test("a synchronous tool is not run in the background", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "remember", systemPrompt: "remembers" });
  const { runtime } = harness();

  const result = await executeTool(runtime.toolContext("remember"), call("rec-1", "recall_memory", { query: "tea" }));
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.content).pending, undefined);
});

test("a large ingest result is saved to a file and the call shows its start and where the rest is", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "remember", systemPrompt: "remembers" });
  const { runtime, nas, yaad } = harness();
  yaad.ingest = async () => ({
    counts: { create_node: 0, update_node: 0, close_node: 0, create_edge: 0, close_edge: 0, noop: 1 },
    operations: Array.from({ length: 400 }, (_, i) => ({ op: "noop" as const, reason: `reason number ${i}` })),
  });

  const result = await executeTool(runtime.toolContext("remember"), call("ing-4", "ingest_memory", { text: "x" }));

  assert.match(result.content, new RegExp(`the whole result is saved at ${config.files.dir}/results/ing-4\\.txt: read_file it`));
  assert.ok(nas.files.get(`${config.files.dir}/results/ing-4.txt`)!.length > 4_000);
});

test("a run's end watches the job's unanswered asks and working helper tasks, and records nothing when none are pending", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "waiter", systemPrompt: "waits" });
  await insertAgent(handle.db, { id: "other", systemPrompt: "other" });
  const { runtime, nas } = harness();
  const { job, ctx } = await inJob(runtime, "waiter");

  await recordPendingWatch(handle.db, nas, "waiter", job.id, 10);
  assert.equal((await handle.db.select().from(watches).where(eq(watches.agentId, "waiter"))).length, 0, "nothing pending, so no watch");

  await deliverAgentMessage(quiet(runtime), { fromAgentId: "waiter", toAgentId: "other", content: "what do you know?", jobId: job.id });
  await executeTool(ctx, call("s1", "steer_browser", { message: "go" }));
  await recordPendingWatch(handle.db, nas, "waiter", job.id, 10);
  const [watch] = await handle.db.select().from(watches).where(eq(watches.agentId, "waiter"));
  assert.deepEqual(watch?.targets, ["other", "task/browser/1"]);
  assert.ok(Math.abs(watch!.dueAt.getTime() - Date.now() - 10 * 60_000) < 5_000);

  await deliverAgentMessage(quiet(runtime), { fromAgentId: "other", toAgentId: "waiter", content: "this much" });
  await recordPendingWatch(handle.db, nas, "waiter", job.id, 10);
  assert.deepEqual((await handle.db.select().from(watches).where(eq(watches.agentId, "waiter")))[0]?.targets, ["task/browser/1"], "an answered ask is no longer waited on");
});

test("an ask is no longer waited on once the agent asked has run since and is idle with nothing pending", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "waiter", systemPrompt: "waits" });
  await insertAgent(handle.db, { id: "other", systemPrompt: "other" });
  const { runtime, nas } = harness();
  const { job } = await inJob(runtime, "waiter");
  await deliverAgentMessage(quiet(runtime), { fromAgentId: "waiter", toAgentId: "other", content: "what do you know?", jobId: job.id });
  assert.deepEqual((await pendingItems(handle.db, nas, job.id)).asks, ["other"], "it has not run since the ask");

  const ran = { id: randomUUID(), agentId: "other", reasonKind: "message" as const, startedAt: new Date(Date.now() + 1_000), endedAt: new Date(Date.now() + 2_000) };
  await handle.db.insert(wakes).values(ran);
  assert.deepEqual((await pendingItems(handle.db, nas, job.id)).asks, [], "it ran and yielded without answering, so nothing is coming");

  await handle.db.insert(watches).values({ agentId: "other", targets: ["task/browser/9"], dueAt: new Date(Date.now() + 60_000) });
  assert.deepEqual((await pendingItems(handle.db, nas, job.id)).asks, ["other"], "it waits on something of its own, so it may still answer");
});

test("a due watch wakes the agent with facts about a task and an agent, and is dropped", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "waiter", systemPrompt: "waits" });
  await insertAgent(handle.db, { id: "other", systemPrompt: "other" });
  const { runtime, nas, dwar } = harness();
  await nas.startTask("browser", { agent_id: "waiter", message: "go" });
  const task = nas.tasks.get("task/browser/1")!;
  const asOf = new Date("2026-10-29T15:00:00Z");
  nas.tasks.set(task.task, { ...task, last_activity: "2026-10-29T14:48:00Z" });
  await handle.db.insert(watches).values({
    agentId: "waiter",
    targets: ["task/browser/1", "other"],
    since: new Date("2026-10-29T14:30:00Z"),
    dueAt: new Date("2026-10-29T14:59:00Z"),
  });

  await runtime.scheduler.tick(new Date("2026-10-29T14:40:00Z"));
  assert.equal((await handle.db.select().from(watches)).length, 1, "not due yet");
  await runtime.scheduler.tick(asOf);
  await runtime.waitUntilIdle();

  assert.equal((await handle.db.select().from(watches)).length, 0);
  const notice = runtime.transcript.transcriptFor("waiter").at(-1)!;
  assert.match(notice.content, /^Your wait timed out after 30 minutes/);
  assert.match(notice.content, /- task\/browser\/1 is working; it last did anything 12 minutes ago\./);
  assert.match(notice.content, /- other: it has never acted; you have not messaged it\./);
  assert.equal(dwar.agentCalls.length, 1);
  assert.match(JSON.stringify(dwar.agentCalls[0]!.messages), /\[Wake\] wait timeout/);
});

test("a watch survives a runtime restart and still falls due", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "waiter", systemPrompt: "waits" });
  await insertAgent(handle.db, { id: "other", systemPrompt: "other" });
  const first = harness();
  const { job } = await inJob(first.runtime, "waiter");
  await deliverAgentMessage(quiet(first.runtime), { fromAgentId: "waiter", toAgentId: "other", content: "what do you know?", jobId: job.id });
  await recordPendingWatch(handle.db, first.nas, "waiter", job.id, 1);
  const second = harness();

  await second.runtime.scheduler.tick(new Date(Date.now() + 2 * 60_000));
  await second.runtime.waitUntilIdle();

  assert.match(second.runtime.transcript.transcriptFor("waiter").at(-1)?.content ?? "", /^Your wait timed out after \d+ minutes with nothing from what you waited on\.\n- other: /);
});

test("a message from the agent waited on wakes the agent and drops the watch", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "waiter", systemPrompt: "waits" });
  await insertAgent(handle.db, { id: "other", systemPrompt: "other" });
  const { runtime, dwar } = harness();
  await handle.db.insert(watches).values({ agentId: "waiter", targets: ["other"], dueAt: new Date(Date.now() + 60_000) });

  await deliverAgentMessage(runtime.deliver, { fromAgentId: "other", toAgentId: "waiter", content: "here is the answer" });
  await runtime.waitUntilIdle();

  assert.equal(dwar.agentCalls.length, 2, "the answer wakes the agent, whose yield then gets the one reminder");
  assert.match(JSON.stringify(dwar.agentCalls[0]!.messages), /\[Wake\] message from other/);
  assert.equal((await handle.db.select().from(watches)).length, 0);
});

test("the running info of GET /agents shows whether the agent runs and what it waits on", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "waiter", systemPrompt: "waits" });
  const { runtime } = harness();
  const since = new Date("2026-10-29T14:30:00Z");
  await handle.db.insert(watches).values({ agentId: "waiter", targets: ["task/browser/1"], since, dueAt: new Date("2026-10-29T15:00:00Z") });
  const { buildApp } = await import("../src/app.js");
  const nas = mockNas({});
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({}), yaad: mockYaad(), ghar: mockGhar(), nas, runtime });
  try {
    const listed = (await app.inject({ method: "GET", url: "/agents" })).json() as {
      agents: Array<{ id: string; running: { working: boolean; waiting_on: unknown; job: unknown } }>;
    };
    const running = listed.agents.find((agent) => agent.id === "waiter")?.running;
    assert.equal(running?.working, false);
    assert.equal(running?.job, null);
    assert.deepEqual(running?.waiting_on, { targets: ["task/browser/1"], since: since.toISOString(), wakes_by: "2026-10-29T15:00:00.000Z" });
  } finally {
    await app.close();
  }
});

test("the yield reminder fires for an agent's unanswered job with nothing pending, and not for Ankur's or when something would wake the agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "asked", systemPrompt: "is asked" });
  await insertAgent(handle.db, { id: "asker", systemPrompt: "asks" });
  await insertAgent(handle.db, { id: "asked-by-ankur", systemPrompt: "is asked by Ankur" });
  const { runtime, nas } = harness();
  const { job, ctx } = await inAgentJob(runtime, "asked", "asker");
  const deps = { db: handle.db, nas };

  const ankurs = await inJob(runtime, "asked-by-ankur");
  assert.notEqual(ankurs.job.answerBy, null);
  assert.equal(await yieldReminder(deps, "asked-by-ankur", ankurs.job.id), null, "answer-by is Ankur's backstop, so no reminder");

  const reminder = await yieldReminder(deps, "asked", job.id);
  assert.match(reminder ?? "", /^\[continue\] asker asked "when is my exam\?" at \d{4}-\d\d-\d\dT.* and nothing you started will wake you\. Answer now, or start what will\.$/);
  assert.equal(await yieldReminder(deps, "asked", null), null, "no job, no reminder");

  await executeTool(ctx, call("s1", "steer_browser", { message: "look it up" }));
  assert.equal(await yieldReminder(deps, "asked", job.id), null, "a working task wakes it");
  nas.tasks.set("task/browser/1", { ...nas.tasks.get("task/browser/1")!, status: "idle" });
  assert.notEqual(await yieldReminder(deps, "asked", job.id), null, "an idle task does not");

  await handle.db.insert(watches).values({ agentId: "asked", targets: [], dueAt: new Date(Date.now() + 60_000) });
  assert.equal(await yieldReminder(deps, "asked", job.id), null, "a watch wakes it");
  await handle.db.delete(watches);

  await handle.db.insert(pendingAsync).values({ id: "p1", agentId: "asked", toolName: "control_device" });
  assert.equal(await yieldReminder(deps, "asked", job.id), null, "a background call wakes it");
  await handle.db.delete(pendingAsync);

  await handle.db.insert(reminders).values({ id: "00000000-0000-4000-8000-0000000000e2", agentId: "asked", authorId: "asked", note: "later", runAt: new Date(Date.now() + 3_600_000) });
  assert.equal(await yieldReminder(deps, "asked", job.id), null, "a reminder of its own wakes it");
  await handle.db.delete(reminders);

  nas.listTasks = async () => {
    throw new Error("nas is down");
  };
  await assert.rejects(() => yieldReminder(deps, "asked", job.id), /nas is down/, "a Nas that cannot be read is an error, not a guess");

  await deliverAgentMessage(quiet(runtime), { fromAgentId: "asked", toAgentId: "asker", content: "Thursday.", jobId: job.id, status: "done" });
  assert.equal(await yieldReminder(deps, "asked", job.id), null, "answered");
});

test("the agent yields once more after the reminder, and a second yield stands", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "asked", systemPrompt: "is asked" });
  await insertAgent(handle.db, { id: "asker", systemPrompt: "asks" });
  const requests: DwarChatRequest[] = [];
  const { runtime, dwar } = harness({
    agent: (request) => {
      requests.push(request);
      return toolUse("yield", {}, `y${requests.length}`);
    },
  });
  const { job } = await inAgentJob(runtime, "asked", "asker");

  runtime.enqueue("asked", "message from asker", { kind: "message", ref: null, openedByMessageId: null, jobId: job.id, jobIsNew: true });
  await runtime.waitUntilIdle();

  assert.equal(dwar.agentCalls.length, 2);
  assert.match(JSON.stringify(dwar.agentCalls[1]!.messages), /nothing you started will wake you/);
  const logs = await handle.db.select().from(agentLogs).where(eq(agentLogs.agentId, "asked"));
  assert.ok(logs.length > 0);
});
