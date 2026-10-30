import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "../src/db/migrate.js";
import { jobs, messages } from "../src/db/schema.js";
import { deliverAgentMessage, deliverUserMessage } from "../src/runtime/deliver.js";
import { createRuntime, type Runtime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { writeAgentLog } from "../src/db/logs.js";
import { LIST_AGENTS, SEND, STEER_WORK, type DwarChatResponse, type MessageStatus } from "../src/types/domain.js";
import {
  insertAgent,
  toolUse,
  yieldTurn,
  mockDwar,
  mockGhar,
  mockNas,
  mockYaad,
  openTestDb,
  resetRuntime,
  silentLog,
  testConfig,
} from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

/** A runtime whose lanes never run: these tests drive the tools directly. */
function idleRuntime(): Runtime {
  return createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
}

/** dispatch sends `content` from `from` to `to` (null is Ankur) on the process lane, with `status` when given. */
function dispatch(runtime: Runtime, from: string, to: string | null, content: string, status?: MessageStatus) {
  return executeTool(runtime.toolContext(from, "process"), {
    type: "tool_use",
    id: `d-${content}`,
    name: SEND,
    input: { to: to ?? "ankur", content, ...(status !== undefined ? { status } : {}) },
  });
}

/** deps delivers without waking anyone, so no lane runs. */
function deps(runtime: Runtime) {
  return { db: handle.db, transcript: runtime.transcript, events: runtime.events, enqueueProcess: () => "", enqueueWork: () => "" };
}

async function jobsOf(agentId: string) {
  return handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
}

test("Ankur's message opens a job; a status on send records its progress and nothing refuses a send for it", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "job-agent", systemPrompt: "agent" });
  const runtime = idleRuntime();

  await deliverUserMessage(deps(runtime), agentId, "find my exam times");
  let [job] = await jobsOf(agentId);
  assert.equal(job?.state, "open");
  assert.equal(job?.requesterId, null);

  assert.equal((await dispatch(runtime, agentId, null, "working on it")).isError, false, "no status is required");
  assert.equal((await dispatch(runtime, agentId, null, "on it", "running")).isError, false);
  assert.equal((await dispatch(runtime, agentId, null, "still on it", "running")).isError, false, "a second progress update goes");

  assert.equal((await dispatch(runtime, agentId, null, "which semester?", "needs_input")).isError, false);
  [job] = await jobsOf(agentId);
  assert.equal(job?.state, "needs_input");
  assert.equal((await dispatch(runtime, agentId, null, "which semester, again?", "needs_input")).isError, false, "a second question goes");

  await deliverUserMessage(deps(runtime), agentId, "fall 2026");
  [job] = await jobsOf(agentId);
  assert.equal(job?.state, "open");
  assert.equal(job?.questionSeq, null);

  assert.equal((await dispatch(runtime, agentId, null, "Wed 1:00 PM", "done")).isError, false);
  [job] = await jobsOf(agentId);
  assert.equal(job?.state, "done");
  const [sent] = await handle.db.select().from(messages).where(eq(messages.content, "Wed 1:00 PM"));
  assert.equal(sent?.status, "done");

  assert.equal((await dispatch(runtime, agentId, null, "anything else?")).isError, false);
  await deliverUserMessage(deps(runtime), agentId, "and my quiz times");
  const all = await jobsOf(agentId);
  assert.deepEqual(all.map((row) => row.state).sort(), ["done", "open"]);
  await runtime.waitUntilIdle();
});

test("an agent's line to its worker opens a job only one way, and a scheduled trigger opens none", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertAgent(handle.db, { id: "job-manager", systemPrompt: "manager" });
  const workerId = await insertAgent(handle.db, { id: "job-worker", systemPrompt: "worker", parentAgentId: managerId });
  const runtime = idleRuntime();

  await deliverAgentMessage(deps(runtime), { fromAgentId: managerId, toAgentId: workerId, content: "read the page" });
  assert.equal((await jobsOf(workerId)).length, 1);
  assert.equal((await jobsOf(managerId)).length, 0);

  assert.equal((await dispatch(runtime, workerId, managerId, "page read")).isError, false);
  assert.equal((await dispatch(runtime, workerId, managerId, "page read: 3 items", "done")).isError, false);
  await deliverAgentMessage(deps(runtime), { fromAgentId: managerId, toAgentId: workerId, content: "thanks, stop there" });
  assert.deepEqual((await jobsOf(workerId)).map((row) => row.state).sort(), ["done", "open"]);

  const routineId = await insertAgent(handle.db, { id: "job-routine", systemPrompt: "routine", parentAgentId: managerId });
  await deliverAgentMessage(deps(runtime), {
    fromAgentId: managerId,
    toAgentId: routineId,
    content: "8 AM batch",
    scheduled: true,
  });
  assert.equal((await jobsOf(routineId)).length, 0);
  await runtime.waitUntilIdle();
});

test("a status sent to an agent that gave no job, while someone else's job is open, is no longer refused", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, { id: "misaddr-parent", systemPrompt: "parent" });
  const courseId = await insertAgent(handle.db, { id: "misaddr-course", systemPrompt: "course", parentAgentId: parentId });
  const runtime = idleRuntime();

  await deliverUserMessage(deps(runtime), courseId, "what did I get on the last exam?");
  assert.equal((await dispatch(runtime, courseId, parentId, "Exam answers for Ankur", "done")).isError, false);
  assert.equal((await dispatch(runtime, courseId, parentId, "FYI: Ankur asked about his exam")).isError, false);
  assert.equal((await dispatch(runtime, courseId, null, "Exam 2: not recorded yet", "done")).isError, false);
  const [job] = await jobsOf(courseId);
  assert.equal(job?.state, "done", "only the status to the requester moves the job");
  await runtime.waitUntilIdle();
});

test("a wake that works a job and stops without reporting leaves it open and tells no one, and a follow-up joins it", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertAgent(handle.db, { id: "settle-manager", systemPrompt: "manager" });
  const workerId = await insertAgent(handle.db, { id: "settle-worker", systemPrompt: "STALLER", parentAgentId: managerId });
  const steered = new Set<string>();
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({
      process: (request) => {
        const job = JSON.stringify(request.messages).includes("read the page");
        if (request.system.includes("STALLER") && job && !steered.has("worker")) {
          steered.add("worker");
          return toolUse(STEER_WORK, { instruction: "read it" }, "steer-1");
        }
        return yieldTurn();
      },
      work: (request) =>
        JSON.stringify(request.messages).includes("list-1") ? yieldTurn() : toolUse(LIST_AGENTS, {}, "list-1"),
    }),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  assert.equal((await dispatch(runtime, managerId, workerId, "read the page")).isError, false);
  await runtime.waitUntilIdle();
  const [job] = await jobsOf(workerId);
  assert.equal(job?.state, "open", "hath never decides from outside that a job stalled");
  assert.equal((await handle.db.select().from(messages).where(eq(messages.toAgentId, managerId))).length, 0);

  assert.equal((await dispatch(runtime, managerId, workerId, "Browser 14 is back")).isError, false);
  await runtime.waitUntilIdle();
  assert.deepEqual((await jobsOf(workerId)).map((row) => row.state), ["open"], "a follow-up joins the open job and never files it away");
  assert.equal((await handle.db.select().from(messages).where(eq(messages.toAgentId, managerId))).length, 0);
});

test("every message wakes the recipient's process lane, a spawned agent's report included", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertAgent(handle.db, { id: "route-manager", systemPrompt: "manager" });
  const workerId = await insertAgent(handle.db, { id: "route-worker", systemPrompt: "worker", parentAgentId: managerId });
  const runtime = idleRuntime();
  const woke: string[] = [];
  const spy = {
    db: handle.db,
    transcript: runtime.transcript,
    events: runtime.events,
    enqueueProcess: (agentId: string) => {
      woke.push(`${agentId}:process`);
   return "";
 },
    enqueueWork: (agentId: string) => {
      woke.push(`${agentId}:work`);
   return "";
 },
  };

  await deliverUserMessage(spy, managerId, "book the room");
  await deliverAgentMessage(spy, { fromAgentId: managerId, toAgentId: workerId, content: "open the booking page" });
  await deliverAgentMessage(spy, { fromAgentId: workerId, toAgentId: managerId, content: "page open", status: "running" });
  assert.deepEqual(woke, ["route-manager:process", "route-worker:process", "route-manager:process"]);
});

/** A model turn of `calls`, each [name, input], ending in yield. */
function turnOf(...calls: Array<[string, Record<string, unknown>]>): DwarChatResponse {
  return {
    provider: "anthropic" as const,
    content: [
      ...calls.map(([name, input], i) => ({ type: "tool_use" as const, id: `t${i}-${name}`, name, input })),
      { type: "tool_use" as const, id: "t-yield", name: "yield", input: {} },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

/** A runtime whose process lane answers each call with the next of `turns`, then yields. */
function scriptedRuntime(turns: Array<() => DwarChatResponse | Promise<DwarChatResponse>>): Runtime {
  let n = 0;
  return createRuntime({
    db: handle.db,
    dwar: mockDwar({
      process: async () => {
        const next = turns[n];
        n += 1;
        return next === undefined ? yieldTurn() : next();
      },
    }),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
}

async function sentBy(agentId: string): Promise<string[]> {
  const rows = await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId));
  return rows.sort((a, b) => a.seq - b.seq).map((row) => row.content);
}

test("a second send to one recipient in the same turn is held back with what already went out", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "turn-agent", systemPrompt: "agent" });
  const runtime = scriptedRuntime([
    () =>
      turnOf(
        [SEND, { to: "ankur", content: "the times", status: "done" }],
        [SEND, { to: "ankur", content: "and the file", status: "done" }],
      ),
  ]);
  await deliverUserMessage({ ...deps(runtime), enqueueProcess: runtime.enqueueProcess }, agentId, "exam times?");
  await runtime.waitUntilIdle();
  assert.deepEqual(await sentBy(agentId), ["the times"]);
});

test("a send over a message the lane has not read waits for the next step", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "stale-agent", systemPrompt: "agent" });
  let runtime: Runtime;
  runtime = scriptedRuntime([
    async () => {
      await deliverUserMessage(deps(runtime), agentId, "actually, Thursday");
      return turnOf([SEND, { to: "ankur", content: "Wednesday is set", status: "done" }]);
    },
    () => turnOf([SEND, { to: "ankur", content: "Thursday is set", status: "done" }]),
  ]);
  await deliverUserMessage({ ...deps(runtime), enqueueProcess: runtime.enqueueProcess }, agentId, "book Wednesday");
  await runtime.waitUntilIdle();
  assert.deepEqual(await sentBy(agentId), ["Thursday is set"]);
});

test("the process lane may message an agent this agent spawned: there is no brought-in gate", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertAgent(handle.db, { id: "voice-manager", systemPrompt: "manager" });
  const workerId = await insertAgent(handle.db, { id: "voice-worker", systemPrompt: "worker", parentAgentId: managerId });
  const runtime = scriptedRuntime([
    () => turnOf([SEND, { to: workerId, content: "stop now" }]),
  ]);
  await deliverAgentMessage(deps(runtime), { fromAgentId: managerId, toAgentId: workerId, content: "open the page" });
  await deliverUserMessage({ ...deps(runtime), enqueueProcess: runtime.enqueueProcess }, managerId, "stop the worker");
  await runtime.waitUntilIdle();
  assert.deepEqual(await sentBy(managerId), ["open the page", "stop now"]);
});
