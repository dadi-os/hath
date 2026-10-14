import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "../src/db/migrate.js";
import { jobs, messages } from "../src/db/schema.js";
import { deliverAgentMessage, deliverUserMessage } from "../src/runtime/deliver.js";
import { createRuntime, type Runtime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { writeAgentLog } from "../src/db/logs.js";
import { RUNTIME_PREFIX } from "../src/db/messages.js";
import { DISPATCH_MESSAGE, LIST_AGENTS, STEER_REASONING, WAIT, type DwarChatResponse, type MessageStatus } from "../src/types/domain.js";
import {
  insertAgent,
  toolUse,
  yieldTurn,
  mockChaavi,
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
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
}

/** dispatch sends `content` from `from` to `to` on the conversation lane, with `status` when given. */
function dispatch(runtime: Runtime, from: string, to: string | null, content: string, status?: MessageStatus) {
  return executeTool(runtime.toolContext(from, "conversation"), {
    type: "tool_use",
    id: `d-${content}`,
    name: DISPATCH_MESSAGE,
    input: { to_agent_id: to, content, ...(status !== undefined ? { status } : {}) },
  });
}

/** deps delivers without waking anyone, so no lane runs. */
function deps(runtime: Runtime) {
  return { db: handle.db, transcript: runtime.transcript, events: runtime.events, enqueueConversation: () => {}, enqueueReasoning: () => {} };
}

async function jobsOf(agentId: string) {
  return handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
}

test("Ankur's message opens a job whose reports carry a status, one progress update and one open question at a time", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "job-agent", systemPrompt: "agent" });
  const runtime = idleRuntime();

  await deliverUserMessage(deps(runtime), agentId, "find my exam times");
  let [job] = await jobsOf(agentId);
  assert.equal(job?.state, "open");
  assert.equal(job?.requesterId, null);

  const bare = await dispatch(runtime, agentId, null, "working on it");
  assert.equal(bare.isError, true);
  assert.match(bare.content, /^Not sent: Ankur gave you a job/);
  assert.equal((await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId))).length, 0);

  assert.equal((await dispatch(runtime, agentId, null, "on it", "running")).isError, false);
  const second = await dispatch(runtime, agentId, null, "still on it", "running");
  assert.equal(second.isError, true);
  assert.match(second.content, /one progress update/);

  assert.equal((await dispatch(runtime, agentId, null, "which semester?", "needs_input")).isError, false);
  [job] = await jobsOf(agentId);
  assert.equal(job?.state, "needs_input");
  const again = await dispatch(runtime, agentId, null, "which semester, again?", "needs_input");
  assert.equal(again.isError, true);
  assert.match(again.content, /still open/);

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

  assert.equal((await dispatch(runtime, managerId, workerId, "read the page")).isError, false);
  assert.equal((await jobsOf(workerId)).length, 1);
  assert.equal((await jobsOf(managerId)).length, 0);

  const bare = await dispatch(runtime, workerId, managerId, "page read");
  assert.equal(bare.isError, true);
  assert.equal((await dispatch(runtime, workerId, managerId, "page read: 3 items", "done")).isError, false);
  assert.equal((await dispatch(runtime, managerId, workerId, "thanks, stop there")).isError, false);
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

test("a wake that works a job and stops without reporting closes it as blocked and tells the requester; an FYI that needs nothing closes as noop", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertAgent(handle.db, { id: "settle-manager", systemPrompt: "manager" });
  const workerId = await insertAgent(handle.db, { id: "settle-worker", systemPrompt: "STALLER", parentAgentId: managerId });
  const steered = new Set<string>();
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({
      converse: (request) => {
        const job = JSON.stringify(request.messages).includes("read the page");
        if (request.system.includes("STALLER") && job && !steered.has("worker")) {
          steered.add("worker");
          return toolUse(STEER_REASONING, { instruction: "read it" }, "steer-1");
        }
        return yieldTurn();
      },
      reason: (request) =>
        JSON.stringify(request.messages).includes("list-1") ? yieldTurn() : toolUse(LIST_AGENTS, {}, "list-1"),
    }),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  assert.equal((await dispatch(runtime, managerId, workerId, "read the page")).isError, false);
  await runtime.waitUntilIdle();
  const [job] = await jobsOf(workerId);
  assert.equal(job?.state, "blocked");
  const reports = await handle.db.select().from(messages).where(eq(messages.toAgentId, managerId));
  assert.equal(reports.length, 1);
  assert.ok(reports[0]!.content.startsWith(`${RUNTIME_PREFIX} My wake ended with your job unfinished`));

  assert.equal((await dispatch(runtime, managerId, workerId, "Browser 14 is back")).isError, false);
  await runtime.waitUntilIdle();
  const states = (await jobsOf(workerId)).map((row) => row.state).sort();
  assert.deepEqual(states, ["blocked", "noop"]);
  assert.equal((await handle.db.select().from(messages).where(eq(messages.toAgentId, managerId))).length, 1);
});

test("a wait renews without a model call while the awaited team works, and returns at its end once it stops", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const waiterId = await insertAgent(handle.db, { id: "renew-waiter", systemPrompt: "waiter" });
  const ownerId = await insertAgent(handle.db, { id: "renew-owner", systemPrompt: "owner" });
  const runtime = idleRuntime();
  const waitFor = () =>
    executeTool(runtime.toolContext(waiterId, "reasoning"), {
      type: "tool_use",
      id: "renew-wait",
      name: WAIT,
      input: { seconds: 2, for: ownerId },
    });

  const idle = JSON.parse((await waitFor()).content);
  assert.equal(idle.waited_seconds, 2);

  const working = setTimeout(() => {
    void writeAgentLog(handle.db, { agentId: ownerId, lane: "reasoning", event: "response", payload: {} });
  }, 1000);
  const renewed = JSON.parse((await waitFor()).content);
  clearTimeout(working);
  assert.equal(renewed.interrupted, false);
  assert.equal(renewed.waited_seconds, 4, "one renewal while the owner worked, none after");
});

test("a report from an agent the recipient brought in wakes its reasoning lane; everything else wakes conversation", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertAgent(handle.db, { id: "route-manager", systemPrompt: "manager" });
  const workerId = await insertAgent(handle.db, { id: "route-worker", systemPrompt: "worker", parentAgentId: managerId });
  const runtime = idleRuntime();
  const woke: string[] = [];
  const spy = {
    db: handle.db,
    transcript: runtime.transcript,
    events: runtime.events,
    enqueueConversation: (agentId: string) => {
      woke.push(`${agentId}:conversation`);
    },
    enqueueReasoning: (agentId: string) => {
      woke.push(`${agentId}:reasoning`);
    },
  };

  await deliverUserMessage(spy, managerId, "book the room");
  await deliverAgentMessage(spy, { fromAgentId: managerId, toAgentId: workerId, content: "open the booking page" });
  await deliverAgentMessage(spy, { fromAgentId: workerId, toAgentId: managerId, content: "page open", status: "running" });
  assert.deepEqual(woke, ["route-manager:conversation", "route-worker:conversation", "route-manager:reasoning"]);
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

/** A runtime whose conversation lane answers each call with the next of `turns`, then yields. */
function scriptedRuntime(turns: Array<() => DwarChatResponse | Promise<DwarChatResponse>>): Runtime {
  let n = 0;
  return createRuntime({
    db: handle.db,
    dwar: mockDwar({
      converse: async () => {
        const next = turns[n];
        n += 1;
        return next === undefined ? yieldTurn() : next();
      },
    }),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
}

async function sentBy(agentId: string): Promise<string[]> {
  const rows = await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId));
  return rows.sort((a, b) => a.seq - b.seq).map((row) => row.content);
}

test("a turn sends one message per recipient", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "turn-agent", systemPrompt: "agent" });
  const runtime = scriptedRuntime([
    () =>
      turnOf(
        [DISPATCH_MESSAGE, { to_agent_id: null, content: "the times", status: "done" }],
        [DISPATCH_MESSAGE, { to_agent_id: null, content: "and the file", status: "done" }],
      ),
  ]);
  await deliverUserMessage({ ...deps(runtime), enqueueConversation: runtime.enqueueConversation }, agentId, "exam times?");
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
      return turnOf([DISPATCH_MESSAGE, { to_agent_id: null, content: "Wednesday is set", status: "done" }]);
    },
    () => turnOf([DISPATCH_MESSAGE, { to_agent_id: null, content: "Thursday is set", status: "done" }]),
  ]);
  await deliverUserMessage({ ...deps(runtime), enqueueConversation: runtime.enqueueConversation }, agentId, "book Wednesday");
  await runtime.waitUntilIdle();
  assert.deepEqual(await sentBy(agentId), ["Thursday is set"]);
});

test("conversation messages an agent it brought in only with a reasoning hand-off", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertAgent(handle.db, { id: "voice-manager", systemPrompt: "manager" });
  const workerId = await insertAgent(handle.db, { id: "voice-worker", systemPrompt: "worker", parentAgentId: managerId });
  const runtime = scriptedRuntime([
    () => turnOf([DISPATCH_MESSAGE, { to_agent_id: workerId, content: "stop now" }]),
  ]);
  await deliverAgentMessage(deps(runtime), { fromAgentId: managerId, toAgentId: workerId, content: "open the page" });
  await deliverUserMessage({ ...deps(runtime), enqueueConversation: runtime.enqueueConversation }, managerId, "stop the worker");
  await runtime.waitUntilIdle();
  assert.deepEqual(await sentBy(managerId), ["open the page"]);
});
