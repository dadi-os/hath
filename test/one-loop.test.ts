import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq, isNull } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { agentActivity, agentLogs, jobs, messages } from "../src/db/schema.js";
import { deliverAgentMessage, deliverUserMessage } from "../src/runtime/deliver.js";
import { createRuntime } from "../src/runtime/engine.js";
import { sendPickups } from "../src/runtime/pickups.js";
import { executeTool } from "../src/runtime/tools.js";
import type { DwarChatRequest } from "../src/types/domain.js";
import { insertAgent, mockDwar, mockGhar, mockNas, mockYaad, openTestDb, resetRuntime, silentLog, testConfig, yieldTurn } from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

function harness(agent?: (request: DwarChatRequest, signal?: AbortSignal) => ReturnType<typeof yieldTurn> | Promise<ReturnType<typeof yieldTurn>>) {
  const nas = mockNas({});
  const yaad = mockYaad();
  const dwar = mockDwar(agent === undefined ? {} : { agent });
  const runtime = createRuntime({ db: handle.db, dwar, yaad, ghar: mockGhar(), nas, config, log: silentLog });
  return { nas, yaad, dwar, runtime };
}

const call = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });

/** Delivery that runs no agent, so a test sets the scene without a wake racing it. */
function quiet(runtime: ReturnType<typeof harness>["runtime"]) {
  return { ...runtime.deliver, enqueue: () => randomUUID(), preempt: () => {} };
}

/** Ankur's open job on `agentId`, and a tool context standing in it. */
async function ankursJob(runtime: ReturnType<typeof harness>["runtime"], agentId: string, ...words: string[]) {
  for (const text of words) {
    await deliverUserMessage(quiet(runtime), agentId, text);
  }
  const [job] = await handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
  return { job: job!, ctx: { ...runtime.toolContext(agentId), jobId: job!.id } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) {
    await sleep(10);
  }
  assert.ok(check(), "the condition came true within two seconds");
}

const answerNotices = (agentId: string) =>
  handle.db
    .select()
    .from(messages)
    .where(and(eq(messages.fromAgentId, agentId), eq(messages.toAgentId, agentId), eq(messages.kind, "notice"), eq(messages.sentBy, "hath")));

test("answer-by: once, with what has and has not come in, and only for a job Ankur opened that is still open", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "answer-agent", systemPrompt: "agent" });
  const peerId = await insertAgent(handle.db, { id: "answer-peer", systemPrompt: "peer" });
  const doneId = await insertAgent(handle.db, { id: "answered-agent", systemPrompt: "agent" });
  const { runtime } = harness();
  const { job } = await ankursJob(runtime, agentId, "what is due tonight?");
  await deliverAgentMessage(quiet(runtime), { fromAgentId: agentId, toAgentId: peerId, content: "what is due tonight?", jobId: job.id });
  await deliverAgentMessage(quiet(runtime), { fromAgentId: peerId, toAgentId: agentId, content: "no class from me" });
  const { job: answered } = await ankursJob(runtime, doneId, "and tomorrow?");
  await deliverAgentMessage(quiet(runtime), { fromAgentId: doneId, toAgentId: null, content: "Nothing.", jobId: answered.id, status: "done" });

  await runtime.scheduler.tick(new Date(Date.now() + 60_000));
  await runtime.waitUntilIdle();
  assert.equal((await answerNotices(agentId)).length, 0, "not due yet");

  await runtime.scheduler.tick(new Date(Date.now() + 6 * 60_000));
  await runtime.waitUntilIdle();
  const [notice] = await answerNotices(agentId);
  assert.match(notice!.content, /^\[Answer time\] Ankur's answer time for job #\d+ \(.*\) has passed and he has no answer from you yet\.\n {2}in: answer-peer answered \(#\d+\)\n {2}not in: nothing$/);
  assert.equal(notice!.jobId, job.id);

  await runtime.scheduler.tick(new Date(Date.now() + 10 * 60_000));
  await runtime.waitUntilIdle();
  assert.equal((await answerNotices(agentId)).length, 1, "told once");
  assert.equal((await answerNotices(doneId)).length, 0, "an answered job is not told");
  assert.equal((await answerNotices(peerId)).length, 0, "a job an agent asked for has no answer time");
});

test("answer-by lists the unanswered ask and the helper still working under not in", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "answer-missing", systemPrompt: "agent" });
  const peerId = await insertAgent(handle.db, { id: "answer-silent", systemPrompt: "peer" });
  const { runtime } = harness();
  const { job, ctx } = await ankursJob(runtime, agentId, "what is due tonight?");
  await deliverAgentMessage(quiet(runtime), { fromAgentId: agentId, toAgentId: peerId, content: "what is due?", jobId: job.id });
  await executeTool(ctx, call("s1", "steer_browser", { message: "read D2L" }));

  await runtime.scheduler.tick(new Date(Date.now() + 6 * 60_000));
  await runtime.waitUntilIdle();
  const [notice] = await answerNotices(agentId);
  assert.match(notice!.content, /in: nothing yet\n {2}not in: answer-silent has not answered, task\/browser\/1 is still working$/);
});

test("a pickup goes only to a live Ankur job that has no word from the agent yet, once", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "pickup-live", systemPrompt: "agent" });
  const { runtime } = harness();
  const { job } = await ankursJob(runtime, agentId, "plan my week");
  await handle.db.insert(agentLogs).values({ id: randomUUID(), agentId, jobId: job.id, event: "response", payload: {} });
  const later = new Date(Date.now() + 200_000);
  const deps = quiet(runtime);

  assert.equal(await sendPickups(deps, later, 180_000, async () => false), 0, "an agent that only yielded has nothing in hand");
  assert.equal(await sendPickups(deps, new Date(Date.now() + 60_000), 180_000, async () => true), 0, "not overdue yet");
  assert.equal(await sendPickups(deps, later, 180_000, async () => true), 1);
  assert.equal(await sendPickups(deps, later, 180_000, async () => true), 0, "once");
  const [pickup] = await handle.db.select().from(messages).where(and(eq(messages.fromAgentId, agentId), isNull(messages.toAgentId)));
  assert.equal(pickup?.content, "Working on it.");
});

test("a pickup is not sent for a job the agent has already answered", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "pickup-answered", systemPrompt: "agent" });
  const { runtime } = harness();
  const { job } = await ankursJob(runtime, agentId, "what is due?");
  await handle.db.insert(agentLogs).values({ id: randomUUID(), agentId, jobId: job.id, event: "response", payload: {} });
  await deliverAgentMessage(quiet(runtime), { fromAgentId: agentId, toAgentId: null, content: "Nothing.", jobId: job.id, status: "done" });
  assert.equal(await sendPickups(quiet(runtime), new Date(Date.now() + 200_000), 180_000, async () => true), 0);
});

test("stopping an agent halts its job's helper tasks, marks the job stopped and records it; the route does the same", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "stopped-agent", systemPrompt: "agent" });
  const { runtime, nas } = harness();
  const { job, ctx } = await ankursJob(runtime, agentId, "reset my router");
  await executeTool(ctx, call("s1", "steer_terminal", { message: "reboot it" }));
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({}), yaad: mockYaad(), ghar: mockGhar(), nas, runtime });
  try {
    const res = await app.inject({ method: "POST", url: `/agents/${agentId}/stop` });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { agent_id: agentId, ended_run: false, job: job.openedSeq, stopped_tasks: ["task/terminal/1"], halt_failed: [] });
  } finally {
    await app.close();
  }
  assert.deepEqual(nas.haltTaskCalls, [{ kind: "terminal", id: "1" }]);
  const [stopped] = await handle.db.select().from(jobs).where(eq(jobs.id, job.id));
  assert.deepEqual([stopped?.state, stopped?.stoppedBy], ["stopped", "ankur"]);
  assert.ok(stopped?.stoppedAt);
  const [row] = await handle.db.select().from(agentActivity).where(and(eq(agentActivity.agentId, agentId), eq(agentActivity.kind, "stop")));
  assert.deepEqual([row?.subject, row?.digest, row?.jobId], [`job #${job.openedSeq}`, "stopped by ankur", job.id]);
});

test("stop_task halts one helper task and records the stop", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "stop-task-agent", systemPrompt: "agent" });
  const { runtime, nas } = harness();
  const { job, ctx } = await ankursJob(runtime, agentId, "log in to D2L");
  await executeTool(ctx, call("s1", "steer_browser", { message: "log in" }));

  const stopped = await executeTool(ctx, call("st1", "stop_task", { id: "task/browser/1" }));
  assert.equal(stopped.isError, false, stopped.content);
  assert.deepEqual(JSON.parse(stopped.content), { stopped: "task/browser/1", status: "stopped" });
  assert.deepEqual(nas.haltTaskCalls, [{ kind: "browser", id: "1" }]);
  const [row] = await handle.db.select().from(agentActivity).where(and(eq(agentActivity.agentId, agentId), eq(agentActivity.kind, "stop")));
  assert.deepEqual([row?.subject, row?.jobId], ["task/browser/1", job.id]);
  assert.equal((await executeTool(ctx, call("st2", "stop_task", { id: "browser/1" }))).isError, true);
});

test("a message from the job's requester cancels the model call in flight and is read first; one from anyone else does not", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "preempted-agent", systemPrompt: "agent" });
  const peerId = await insertAgent(handle.db, { id: "preempt-peer", systemPrompt: "peer" });
  let calls = 0;
  const { runtime, dwar } = harness((_request, signal) => {
    calls += 1;
    return calls === 1
      ? new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("request cancelled")), { once: true });
        })
      : yieldTurn();
  });

  await deliverUserMessage(runtime.deliver, agentId, "what is due tonight?");
  await until(() => dwar.agentCalls.length === 1);

  await deliverAgentMessage(runtime.deliver, { fromAgentId: peerId, toAgentId: agentId, content: "fyi from a colleague" });
  await sleep(100);
  assert.equal(dwar.agentCalls.length, 1, "an arrival from another job leaves the call alone");

  await deliverUserMessage(runtime.deliver, agentId, "only the exams");
  await runtime.waitUntilIdle();
  assert.ok(dwar.agentCalls.length >= 2);
  const second = JSON.stringify(dwar.agentCalls[1]!.messages.at(-1));
  assert.match(second, /only the exams/);
  assert.match(second, /fyi from a colleague/);
  assert.match(second, /job #\d+/);
  const aborted = (await handle.db.select().from(agentLogs).where(eq(agentLogs.agentId, agentId))).filter((row) => row.payload.aborted === true);
  assert.equal(aborted.length, 1);
});

test("a wake that continues a job starts with the job's earlier steps, thinking left out", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "continuing-agent", systemPrompt: "agent" });
  const { runtime, dwar } = harness();
  const { job } = await ankursJob(runtime, agentId, "what is due tonight?");
  const earlier = randomUUID();
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  await handle.db.insert(agentLogs).values([
    {
      id: randomUUID(),
      agentId,
      jobId: job.id,
      wakeId: earlier,
      event: "response",
      payload: {
        provider: "anthropic",
        stop_reason: "tool_use",
        usage,
        content: [
          { type: "thinking", thinking: "private working out", signature: "sig" },
          { type: "tool_use", id: "rc1", name: "recall_memory", input: { relevant_on: "2026-11-14" } },
        ],
      },
      createdAt: new Date(Date.now() - 60_000),
    },
    {
      id: randomUUID(),
      agentId,
      jobId: job.id,
      wakeId: earlier,
      event: "tool_result",
      payload: { tool_use_id: "rc1", name: "recall_memory", content: "due tonight: CSE 300 quiz at 11:59 PM", is_error: false },
      createdAt: new Date(Date.now() - 59_000),
    },
  ]);

  runtime.enqueue(agentId, "helper result from task/browser/1", { kind: "message", ref: null, openedByMessageId: null, jobId: job.id, jobIsNew: false });
  await runtime.waitUntilIdle();

  const first = JSON.stringify(dwar.agentCalls[0]!.messages);
  assert.match(first, /"id":"rc1"/);
  assert.match(first, /due tonight: CSE 300 quiz at 11:59 PM/);
  assert.ok(!first.includes("private working out"));
  assert.ok(first.indexOf("[Wake]") < first.indexOf('"id":"rc1"'), "the header comes before the earlier steps");
});

test("ingest_memory sends every message Ankur wrote in the job as source_text, and none outside a job", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "source-agent", systemPrompt: "agent" });
  const peerId = await insertAgent(handle.db, { id: "source-peer", systemPrompt: "peer" });
  const { runtime, yaad } = harness();
  const { ctx } = await ankursJob(runtime, agentId, "HW3 is due Nov 11", "I turned it in already");
  await deliverAgentMessage(quiet(runtime), { fromAgentId: peerId, toAgentId: agentId, content: "not his words" });

  await executeTool(ctx, call("i1", "ingest_memory", { text: "HW3 done." }));
  assert.equal(yaad.ingestCalls[0]?.source_text, "HW3 is due Nov 11\n\nI turned it in already");

  await executeTool(runtime.toolContext(agentId), call("i2", "ingest_memory", { text: "A routine fact." }));
  assert.equal("source_text" in yaad.ingestCalls[1]!, false);
});

test("two messages from Ankur racing to open the line's job end in one job, and neither fails", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "racing-agent", systemPrompt: "agent" });
  const { runtime } = harness();

  await Promise.all([deliverUserMessage(quiet(runtime), agentId, "one"), deliverUserMessage(quiet(runtime), agentId, "two")]);

  const rows = await handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
  assert.equal(rows.length, 1);
  const stamped = await handle.db.select().from(messages).where(eq(messages.toAgentId, agentId));
  assert.deepEqual(stamped.map((row) => row.jobId), [rows[0]!.id, rows[0]!.id]);
});
