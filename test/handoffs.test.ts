import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { createHandoff } from "../src/db/handoffs.js";
import { migrate } from "../src/db/migrate.js";
import { handoffs, jobs, messages } from "../src/db/schema.js";
import { deliverAgentMessage, deliverUserMessage } from "../src/runtime/deliver.js";
import { createRuntime, type Runtime } from "../src/runtime/engine.js";
import { recoverInterruptedWakes } from "../src/runtime/recovery.js";
import { executeTool } from "../src/runtime/tools.js";
import { DECLINE_HANDOFF, DISPATCH_MESSAGE, HAND_OFF } from "../src/types/domain.js";
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
  toolUse,
  waitingHandoffId,
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

type Converse = Parameters<typeof mockDwar>[0]["process"];
type Reason = Parameters<typeof mockDwar>[0]["work"];

function runtimeWith(converse?: Converse, reason?: Reason) {
  const dwar = mockDwar({ ...(converse ? { process: converse } : {}), ...(reason ? { work: reason } : {}) });
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  return { dwar, runtime };
}

/** A process-lane mock that sends the first hand-off it is shown to Ankur, as written, then yields. */
function sendsHandoffToAnkur(extra: Record<string, unknown> = {}): Converse {
  let sent = false;
  return async (request) => {
    if (!sent && JSON.stringify(request.messages).includes("[Hand-offs waiting]")) {
      sent = true;
      return toolUse(DISPATCH_MESSAGE, { handoff_id: waitingHandoffId(request), ...extra }, "c-dispatch");
    }
    return yieldTurn("c-yield");
  };
}

/** Deliveries that wake no lane, so the test drives the lanes itself. */
function quietDeps(runtime: Runtime) {
  return {
    db: handle.db,
    transcript: runtime.transcript,
    events: runtime.events,
    enqueueProcess: () => randomUUID(),
    enqueueWork: () => randomUUID(),
  };
}

function handOff(runtime: Runtime, agentId: string, input: Record<string, unknown>) {
  return executeTool(runtime.toolContext(agentId, "work"), {
    type: "tool_use",
    id: `h-${String(input.content)}`,
    name: HAND_OFF,
    input,
  });
}

test("a hand-off to Ankur waits, reaches the process lane, and is sent as written", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ho-agent", systemPrompt: "agent" });
  const { dwar, runtime } = runtimeWith(sendsHandoffToAnkur());

  const made = await handOff(runtime, agentId, { to: "ankur", kind: "note", content: "the exam moved to Friday" });
  assert.equal(made.isError, false, made.content);
  await runtime.waitUntilIdle();

  assert.ok(dwar.processCalls.length >= 1);
  const [row] = await handle.db.select().from(handoffs).where(eq(handoffs.agentId, agentId));
  assert.equal(row?.state, "sent");
  assert.equal(row?.expectsReply, false);
  const sent = await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId));
  assert.deepEqual(sent.map((message) => [message.toAgentId, message.content, message.status]), [[null, "the exam moved to Friday", null]]);
  assert.equal(row?.messageId, sent[0]?.id);
});

test("the process lane may reword a hand-off to Ankur but sends one to an agent as written", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ho-reword", systemPrompt: "agent" });
  const peerId = await insertAgent(handle.db, { id: "ho-peer", systemPrompt: "peer" });
  const { runtime } = runtimeWith();

  const toAnkur = await createHandoff(handle.db, { agentId, to: null, kind: "note", content: "raw text", attachmentIds: [] });
  const toPeer = await createHandoff(handle.db, { agentId, to: peerId, kind: "note", content: "peer text", attachmentIds: [] });
  const voice = runtime.toolContext(agentId, "process");
  const dispatch = (input: Record<string, unknown>) =>
    executeTool(voice, { type: "tool_use", id: `d-${JSON.stringify(input)}`, name: DISPATCH_MESSAGE, input });

  const reworded = await dispatch({ handoff_id: toPeer.id, content: "my words" });
  assert.equal(reworded.isError, true);
  assert.match(reworded.content, /sent as written/);
  const misaddressed = await dispatch({ handoff_id: toPeer.id, to_agent_id: null });
  assert.equal(misaddressed.isError, true);
  assert.match(misaddressed.content, /own recipient/);
  const another = await dispatch({ handoff_id: 999_999 });
  assert.equal(another.isError, true);

  assert.equal((await dispatch({ handoff_id: toAnkur.id, content: "polished text" })).isError, false);
  assert.equal((await dispatch({ handoff_id: toPeer.id })).isError, false);
  const sent = await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId));
  assert.deepEqual(sent.map((message) => [message.toAgentId, message.content]).sort(), [
    [null, "polished text"],
    [peerId, "peer text"],
  ]);
  await runtime.waitUntilIdle();
});

test("a result hand-off is sent with status done and closes the job; the agent never writes the status", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ho-result", systemPrompt: "agent" });
  const { runtime } = runtimeWith(sendsHandoffToAnkur());

  await deliverUserMessage(quietDeps(runtime), agentId, "find my exam times");
  const made = await handOff(runtime, agentId, { to: "requester", kind: "result", content: "Wed 1:00 PM" });
  assert.equal(made.isError, false, made.content);
  await runtime.waitUntilIdle();

  const [sent] = await handle.db.select().from(messages).where(eq(messages.content, "Wed 1:00 PM"));
  assert.equal(sent?.status, "done");
  assert.equal(sent?.toAgentId, null);
  const [job] = await handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
  assert.equal(job?.state, "done");
});

test("hand-offs that break a job rule are refused where they are made, with the way to fix them", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ho-rules", systemPrompt: "agent" });
  const parentId = await insertAgent(handle.db, { id: "ho-requester", systemPrompt: "requester" });
  const childId = await insertAgent(handle.db, { id: "ho-child", systemPrompt: "child", parentAgentId: agentId });
  const { runtime } = runtimeWith(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return yieldTurn("c-yield");
  });

  await deliverAgentMessage(quietDeps(runtime), { fromAgentId: parentId, toAgentId: agentId, content: "check the page" });

  const bare = await handOff(runtime, agentId, { to: parentId, kind: "note", content: "working on it" });
  assert.equal(bare.isError, true);
  assert.match(bare.content, /^Not handed off: ho-requester gave you a job that is still open/);

  const misaddressed = await handOff(runtime, agentId, { to: "ankur", kind: "result", content: "done" });
  assert.equal(misaddressed.isError, true);
  assert.match(misaddressed.content, /^Not handed off: Ankur gave you no open job/);

  const control = await handOff(runtime, agentId, { to: childId, kind: "note", content: "go on" });
  assert.equal(control.isError, true);
  assert.match(control.content, /send_message/);

  const badRecipient = await handOff(runtime, agentId, { to: "Ankur Desai", kind: "note", content: "hi" });
  assert.equal(badRecipient.isError, true);

  const first = await handOff(runtime, agentId, { to: "requester", kind: "progress", content: "half done" });
  assert.equal(first.isError, false, first.content);
  const second = await handOff(runtime, agentId, { to: "requester", kind: "result", content: "all done" });
  assert.equal(second.isError, true);
  assert.match(second.content, /hand-off #\d+ to ho-requester is still waiting/);
  await runtime.waitUntilIdle();
});

test("a process lane that yields with a hand-off waiting is asked again, then fails loudly and the hand-off is recorded as failed", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ho-stuck", systemPrompt: "agent" });
  const { dwar, runtime } = runtimeWith(async () => yieldTurn("c-yield"));

  const made = await handOff(runtime, agentId, { to: "ankur", kind: "note", content: "never sent" });
  assert.equal(made.isError, false, made.content);
  await runtime.waitUntilIdle();

  assert.equal(dwar.processCalls.length, 4, "one call and three reminders");
  assert.match(JSON.stringify(dwar.processCalls[1]!.messages), /Hand-offs are still waiting/);
  const [row] = await handle.db.select().from(handoffs).where(eq(handoffs.agentId, agentId));
  assert.equal(row?.state, "failed");
  assert.match(row?.reason ?? "", /still waiting/);
  assert.equal(runtime.steer.hasItems(agentId), true, "the work lane is told it was not sent");
  assert.equal((await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId))).length, 0);
});

test("a declined hand-off returns to the work lane with the reason", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ho-decline", systemPrompt: "agent" });
  let declined = false;
  const { dwar, runtime } = runtimeWith(async (request) => {
    if (!declined && JSON.stringify(request.messages).includes("[Hand-offs waiting]")) {
      declined = true;
      return toolUse(DECLINE_HANDOFF, { handoff_id: waitingHandoffId(request), reason: "already covered by the earlier message" }, "c-decline");
    }
    return yieldTurn("c-yield");
  });

  const made = await handOff(runtime, agentId, { to: "ankur", kind: "note", content: "said before" });
  assert.equal(made.isError, false, made.content);
  await runtime.waitUntilIdle();

  const [row] = await handle.db.select().from(handoffs).where(eq(handoffs.agentId, agentId));
  assert.equal(row?.state, "declined");
  assert.equal(row?.reason, "already covered by the earlier message");
  assert.match(JSON.stringify(dwar.workCalls.map((request) => request.messages)), /was not sent: already covered by the earlier message/);
  assert.equal((await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId))).length, 0);
});

test("the reply to a handed-off question wakes the work lane, not the process lane", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ho-asker", systemPrompt: "agent" });
  const requesterId = await insertAgent(handle.db, { id: "ho-asked", systemPrompt: "requester" });
  let sent = false;
  const { dwar, runtime } = runtimeWith(async (request) => {
    if (!sent && JSON.stringify(request.messages).includes("[Hand-offs waiting]")) {
      sent = true;
      return toolUse(DISPATCH_MESSAGE, { handoff_id: waitingHandoffId(request, requesterId) }, "c-dispatch");
    }
    return yieldTurn("c-yield");
  });

  await deliverAgentMessage(quietDeps(runtime), { fromAgentId: requesterId, toAgentId: agentId, content: "pick a semester" });
  const made = await handOff(runtime, agentId, { to: "requester", kind: "question", content: "which semester?" });
  assert.equal(made.isError, false, made.content);
  await runtime.waitUntilIdle();
  const [row] = await handle.db.select().from(handoffs).where(eq(handoffs.agentId, agentId));
  assert.equal(row?.state, "sent");
  assert.equal(row?.expectsReply, true);
  const workBefore = dwar.workCalls.length;

  await deliverAgentMessage(
    { db: handle.db, transcript: runtime.transcript, events: runtime.events, enqueueProcess: runtime.enqueueProcess, enqueueWork: runtime.enqueueWork },
    { fromAgentId: requesterId, toAgentId: agentId, content: "fall 2026" },
  );
  await runtime.waitUntilIdle();

  assert.ok(dwar.workCalls.length > workBefore, "the reply woke the work lane");
  const [after] = await handle.db.select().from(handoffs).where(eq(handoffs.agentId, agentId));
  assert.equal(after?.expectsReply, false, "the wait ends with the first reply");
});

test("boot recovery wakes the process lane of an agent with a hand-off still waiting", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ho-boot", systemPrompt: "agent" });
  const { runtime } = runtimeWith();
  await createHandoff(handle.db, { agentId, to: null, kind: "note", content: "left over", attachmentIds: [] });

  const woken: string[] = [];
  await recoverInterruptedWakes({
    ...quietDeps(runtime),
    enqueueProcess: (id: string) => {
      woken.push(id);
      return "";
    },
    log: silentLog,
    recoveryWindowMinutes: 60,
  });

  assert.deepEqual(woken, [agentId]);
  await runtime.waitUntilIdle();
});
