import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "../src/db/migrate.js";
import { agentLogs, pendingAsync, scheduledMessages, watches } from "../src/db/schema.js";
import { reportLostAsync } from "../src/runtime/async.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { yieldReminder } from "../src/runtime/yield-reminder.js";
import type { DwarChatRequest } from "../src/types/domain.js";
import { deliverUserMessage } from "../src/runtime/deliver.js";
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

function harness(opts: { work?: (request: DwarChatRequest) => ReturnType<typeof yieldTurn> } = {}) {
  const nas = mockNas({});
  const gate: { release: () => void } = { release: () => {} };
  const yaad = mockYaad({
    ingest: async () => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return { counts: { create_node: 1, update_node: 0, close_node: 0, create_edge: 0, close_edge: 0, noop: 0 }, operations: [] };
    },
  });
  const dwar = mockDwar({ work: opts.work ?? (() => yieldTurn()) });
  const runtime = createRuntime({ db: handle.db, dwar, yaad, ghar: mockGhar(), nas, config, log: silentLog });
  return { nas, dwar, yaad, runtime, gate };
}

const call = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });

test("an async tool returns pending at once, and its result wakes the work lane as a message", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "remember", systemPrompt: "remembers" });
  const { runtime, yaad, gate, dwar } = harness();

  const started = await executeTool(runtime.toolContext("remember", "work"), call("ing-1", "ingest_memory", { text: "Ankur likes tea." }));
  assert.equal(started.isError, false);
  assert.equal(JSON.parse(started.content).pending, "ing-1");
  assert.equal(yaad.ingestCalls.length, 1, "it is running");
  assert.equal((await handle.db.select().from(pendingAsync)).length, 1);
  assert.equal(dwar.workCalls.length, 0, "nothing woke the lane yet");

  gate.release();
  await runtime.waitUntilIdle();

  assert.equal((await handle.db.select().from(pendingAsync)).length, 0, "the call is done");
  const notice = runtime.transcript.transcriptFor("remember").at(-1)!;
  assert.equal(notice.kind, "notice");
  assert.match(notice.content, /^Result of ingest_memory \(ing-1\), done:\n/);
  assert.equal(dwar.workCalls.length, 1, "the work lane woke for the result");
  assert.match(JSON.stringify(dwar.workCalls[0]!.messages), /Woken by: async tool result \(ingest_memory ing-1\)/);
});

test("an async tool's failure arrives as the message too", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "remember", systemPrompt: "remembers" });
  const { runtime, yaad } = harness();
  yaad.ingest = async () => {
    throw new Error("yaad exploded");
  };

  await executeTool(runtime.toolContext("remember", "work"), call("ing-2", "ingest_memory", { text: "x" }));
  await runtime.waitUntilIdle();

  const notice = runtime.transcript.transcriptFor("remember").at(-1)!;
  assert.match(notice.content, /^Result of ingest_memory \(ing-2\), failed:\n/);
  assert.equal((await handle.db.select().from(pendingAsync)).length, 0);
});

test("a call a restart cut short is reported lost at boot, and the agent's work lane wakes for it", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "remember", systemPrompt: "remembers" });
  const { runtime, dwar } = harness();
  await handle.db.insert(pendingAsync).values({ id: "ing-3", agentId: "remember", toolName: "ingest_memory" });

  const lost = await reportLostAsync({
    db: handle.db,
    transcript: runtime.transcript,
    events: runtime.events,
    enqueueProcess: runtime.enqueueProcess,
    enqueueWork: runtime.enqueueWork,
    wakeOf: runtime.wakeOf,
  });
  await runtime.waitUntilIdle();

  assert.equal(lost, 1);
  assert.match(runtime.transcript.transcriptFor("remember").at(-1)!.content, /^Result of ingest_memory \(ing-3\) lost: hath restarted/);
  assert.equal(dwar.workCalls.length, 1);
  assert.equal((await handle.db.select().from(pendingAsync)).length, 0);
});

test("a synchronous tool is not run in the background", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "remember", systemPrompt: "remembers" });
  const { runtime, yaad } = harness();
  yaad.recall = async () => ({ nodes: [], edges: [], sufficient: false, coverage: 0 });

  const result = await executeTool(runtime.toolContext("remember", "work"), call("rec-1", "recall_memory", { query: "tea" }));
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.content).pending, undefined);
});

test("a large result is saved to a file and the message shows its start and where the rest is", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "remember", systemPrompt: "remembers" });
  const { runtime, nas, yaad, gate } = harness();
  yaad.ingest = async () => ({
    counts: { create_node: 0, update_node: 0, close_node: 0, create_edge: 0, close_edge: 0, noop: 1 },
    operations: Array.from({ length: 400 }, (_, i) => ({ op: "noop" as const, reason: `reason number ${i}` })),
  });

  await executeTool(runtime.toolContext("remember", "work"), call("ing-4", "ingest_memory", { text: "x" }));
  gate.release();
  await runtime.waitUntilIdle();

  const notice = runtime.transcript.transcriptFor("remember").at(-1)!;
  assert.match(notice.content, new RegExp(`the whole result is saved at ${config.files.dir}/results/ing-4\\.txt: read_file it`));
  assert.ok(nas.files.get(`${config.files.dir}/results/ing-4.txt`)!.length > 4_000);
});

test("wait records what the agent waits on, ends nothing by itself, and refuses a target that does not exist", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "waiter", systemPrompt: "waits" });
  await insertAgent(handle.db, { id: "other", systemPrompt: "other" });
  const { runtime, nas } = harness();
  await nas.startTask("browser", { agent_id: "waiter", message: "go" });
  const ctx = runtime.toolContext("waiter", "work");

  const waited = await executeTool(ctx, call("w1", "wait", { on: ["task/browser/1", "other"], timeout_minutes: 10 }));
  assert.equal(waited.isError, false, waited.content);
  const [watch] = await handle.db.select().from(watches).where(eq(watches.agentId, "waiter"));
  assert.deepEqual(watch?.targets, ["task/browser/1", "other"]);
  assert.ok(Math.abs(watch!.dueAt.getTime() - Date.now() - 10 * 60_000) < 5_000);

  assert.equal((await executeTool(ctx, call("w2", "wait", { on: "task/browser/99", timeout_minutes: 5 }))).isError, true);
  assert.equal((await executeTool(ctx, call("w3", "wait", { on: "nobody-here", timeout_minutes: 5 }))).isError, true);
  assert.equal((await executeTool(ctx, call("w4", "wait", { on: "other", timeout_minutes: 0 }))).isError, true);
  assert.deepEqual((await handle.db.select().from(watches).where(eq(watches.agentId, "waiter")))[0]?.targets, ["task/browser/1", "other"], "a refused wait changes nothing");
});

test("a due watch wakes the work lane with facts about a task and an agent, and is dropped", async () => {
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
  assert.equal(dwar.workCalls.length, 1);
  assert.match(JSON.stringify(dwar.workCalls[0]!.messages), /Woken by: wait timeout/);
});

test("a watch survives a runtime restart and still falls due", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "waiter", systemPrompt: "waits" });
  await insertAgent(handle.db, { id: "other", systemPrompt: "other" });
  const first = harness();
  await executeTool(first.runtime.toolContext("waiter", "work"), call("w1", "wait", { on: "other", timeout_minutes: 1 }));
  const second = harness();

  await second.runtime.scheduler.tick(new Date(Date.now() + 2 * 60_000));
  await second.runtime.waitUntilIdle();

  assert.match(second.runtime.transcript.transcriptFor("waiter").at(-1)?.content ?? "", /Your wait timed out/);
});

test("a message from the agent waited on wakes the work lane and drops the watch", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "waiter", systemPrompt: "waits" });
  await insertAgent(handle.db, { id: "other", systemPrompt: "other" });
  const { runtime, dwar } = harness();
  await handle.db.insert(watches).values({ agentId: "waiter", targets: ["other"], dueAt: new Date(Date.now() + 60_000) });

  const { deliverAgentMessage } = await import("../src/runtime/deliver.js");
  await deliverAgentMessage(
    { db: handle.db, transcript: runtime.transcript, events: runtime.events, enqueueProcess: runtime.enqueueProcess, enqueueWork: runtime.enqueueWork, wakeOf: runtime.wakeOf },
    { fromAgentId: "other", toAgentId: "waiter", content: "here is the answer" },
  );
  await runtime.waitUntilIdle();

  assert.equal(dwar.workCalls.length, 1);
  assert.equal(dwar.processCalls.length, 0);
  assert.match(JSON.stringify(dwar.workCalls[0]!.messages), /Woken by: message from other/);
  assert.equal((await handle.db.select().from(watches)).length, 0);
});

test("the running info of GET /agents shows what the agent waits on", async () => {
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
      agents: Array<{ id: string; running: { waiting_on: unknown } }>;
    };
    assert.deepEqual(listed.agents.find((agent) => agent.id === "waiter")?.running.waiting_on, {
      targets: ["task/browser/1"],
      since: since.toISOString(),
      wakes_by: "2026-10-29T15:00:00.000Z",
    });
  } finally {
    await app.close();
  }
});

test("the yield reminder fires for an unanswered request with nothing pending, and not when something would wake the agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "asked", systemPrompt: "is asked" });
  const { runtime, nas } = harness();
  const deps = { db: handle.db, nas, transcript: runtime.transcript };
  await deliverUserMessage(
    { db: handle.db, transcript: runtime.transcript, events: runtime.events, enqueueProcess: () => "w", enqueueWork: () => "w" },
    "asked",
    "when is my exam?",
  );

  const reminder = await yieldReminder(deps, "asked");
  assert.match(reminder ?? "", /^\[continue\] Ankur asked "when is my exam\?" at \d{4}-\d\d-\d\dT.* and nothing you started will wake you\. Answer now, or start or wait on what will\.$/);

  await nas.startTask("browser", { agent_id: "asked", message: "look it up" });
  assert.equal(await yieldReminder(deps, "asked"), null, "a running task wakes it");
  nas.tasks.set("task/browser/1", { ...nas.tasks.get("task/browser/1")!, status: "idle" });
  assert.notEqual(await yieldReminder(deps, "asked"), null, "an idle task does not");

  await handle.db.insert(watches).values({ agentId: "asked", targets: ["task/browser/1"], dueAt: new Date(Date.now() + 60_000) });
  assert.equal(await yieldReminder(deps, "asked"), null, "a wait wakes it");
  await handle.db.delete(watches);

  await handle.db.insert(pendingAsync).values({ id: "p1", agentId: "asked", toolName: "ingest_memory" });
  assert.equal(await yieldReminder(deps, "asked"), null, "an async call wakes it");
  await handle.db.delete(pendingAsync);

  const row = { fromAgentId: "asked", toAgentId: "asked", content: "later", runAt: new Date(Date.now() + 3_600_000) };
  await handle.db.insert(scheduledMessages).values({ id: "00000000-0000-4000-8000-0000000000e1", ...row, intervalMinutes: 1440 });
  assert.notEqual(await yieldReminder(deps, "asked"), null, "a recurring routine does not");
  await handle.db.insert(scheduledMessages).values({ id: "00000000-0000-4000-8000-0000000000e2", ...row });
  assert.equal(await yieldReminder(deps, "asked"), null, "a one-shot scheduled message wakes it");
  await handle.db.delete(scheduledMessages);

  runtime.transcript.append({ fromAgentId: "asked", toAgentId: null, content: "Thursday." });
  assert.equal(await yieldReminder(deps, "asked"), null, "answered");
});

test("the work lane yields once more after the reminder, and a second yield stands", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "asked", systemPrompt: "is asked" });
  const requests: DwarChatRequest[] = [];
  const { runtime, dwar } = harness({
    work: (request) => {
      requests.push(request);
      return toolUse("yield", {}, `y${requests.length}`);
    },
  });
  await deliverUserMessage(
    { db: handle.db, transcript: runtime.transcript, events: runtime.events, enqueueProcess: () => "w", enqueueWork: () => "w" },
    "asked",
    "when is my exam?",
  );

  runtime.enqueueWork("asked", "message from Ankur");
  await runtime.waitUntilIdle();

  assert.equal(dwar.workCalls.length, 2);
  assert.match(JSON.stringify(dwar.workCalls[1]!.messages), /nothing you started will wake you/);
  const logs = await handle.db.select().from(agentLogs).where(eq(agentLogs.agentId, "asked"));
  assert.ok(logs.length > 0);
});
