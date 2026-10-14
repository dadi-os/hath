import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "../src/db/migrate.js";
import { jobs, messages } from "../src/db/schema.js";
import { deliverAgentMessage, deliverUserMessage } from "../src/runtime/deliver.js";
import { createRuntime, type Runtime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { DISPATCH_MESSAGE, type MessageStatus } from "../src/types/domain.js";
import {
  insertAgent,
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
  return { db: handle.db, transcript: runtime.transcript, events: runtime.events, enqueueConversation: () => {} };
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
