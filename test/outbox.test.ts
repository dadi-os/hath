import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { queueOutbox } from "../src/db/outbox.js";
import { migrate } from "../src/db/migrate.js";
import { attachments, jobs, messages, outbox } from "../src/db/schema.js";
import { deliverAgentMessage, deliverUserMessage } from "../src/runtime/deliver.js";
import { createRuntime, type Runtime } from "../src/runtime/engine.js";
import { recoverInterruptedWakes } from "../src/runtime/recovery.js";
import { executeTool } from "../src/runtime/tools.js";
import { MESSAGE, SEND } from "../src/types/domain.js";
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
  waitingMessageId,
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
    nas: mockNas(),
    config,
    log: silentLog,
  });
  return { dwar, runtime };
}


/** A process-lane mock that sends the first work-lane message it is shown to Ankur, then yields. */
function sendsOutboxToAnkur(content: string): Converse {
  let sent = false;
  return async (request) => {
    if (!sent && JSON.stringify(request.messages).includes("[Messages from work]")) {
      sent = true;
      return toolUse(SEND, { to: "ankur", content }, "c-send");
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

function message(runtime: Runtime, agentId: string, input: Record<string, unknown>) {
  return executeTool(runtime.toolContext(agentId, "work"), {
    type: "tool_use",
    id: `m-${String(input.content)}`,
    name: MESSAGE,
    input,
  });
}

function send(runtime: Runtime, agentId: string, input: Record<string, unknown>) {
  return executeTool(runtime.toolContext(agentId, "process"), {
    type: "tool_use",
    id: `s-${String(input.content)}`,
    name: SEND,
    input,
  });
}

test("a message from work waits in the outbox, shows in the process lane's view, and a send to its recipient closes it", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ob-agent", systemPrompt: "agent" });
  const { dwar, runtime } = runtimeWith(sendsOutboxToAnkur("the exam moved to Friday"));

  const made = await message(runtime, agentId, { to: "ankur", content: "exam moved to Friday" });
  assert.equal(made.isError, false, made.content);
  await runtime.waitUntilIdle();

  assert.ok(dwar.processCalls.length >= 1);
  assert.equal(dwar.workCalls.length, 0, "queueing a message wakes the process lane only");
  const [row] = await handle.db.select().from(outbox).where(eq(outbox.agentId, agentId));
  assert.equal(row?.state, "sent");
  const sent = await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId));
  assert.deepEqual(sent.map((entry) => [entry.toAgentId, entry.content, entry.status]), [[null, "the exam moved to Friday", null]]);
  assert.equal(row?.messageId, sent[0]?.id);
  const request = dwar.processCalls[0]!;
  assert.match(JSON.stringify(request.messages.at(-1)), /\[Status\]/, "the status block is the last turn");
  assert.equal(waitingMessageId(request), row?.id);
});

test("one send closes every message waiting for that recipient and carries their files", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const nas = mockNas({});
  nas.files.set("/var/home/dadi/plan.md", Buffer.from("# plan\n"));
  const agentId = await insertAgent(handle.db, { id: "ob-merge", systemPrompt: "agent" });
  const peerId = await insertAgent(handle.db, { id: "ob-peer", systemPrompt: "peer" });
  const runtime = createRuntime({ db: handle.db, dwar: mockDwar({}), yaad: mockYaad(), ghar: mockGhar(), nas, config, log: silentLog });

  await message(runtime, agentId, { to: "ankur", content: "first", attachments: ["/var/home/dadi/plan.md"] });
  await message(runtime, agentId, { to: "ankur", content: "second" });
  await message(runtime, agentId, { to: peerId, content: "for the peer" });
  await runtime.waitUntilIdle();
  const merged = await send(runtime, agentId, { to: "ankur", content: "first and second" });
  assert.equal(merged.isError, false, merged.content);

  const rows = await handle.db.select().from(outbox).where(eq(outbox.agentId, agentId));
  assert.deepEqual(rows.map((row) => row.state).sort(), ["pending", "sent", "sent"]);
  const [carried] = await handle.db.select().from(attachments).where(eq(attachments.filename, "plan.md"));
  assert.notEqual(carried?.messageId, null, "the queued file went out with the send");
});

test("send snapshots a file path into the attachments store at send time", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const nas = mockNas({});
  nas.files.set("/var/home/dadi/report.md", Buffer.from("# Title\nbody\n"));
  const agentId = await insertAgent(handle.db, { id: "ob-snap", systemPrompt: "agent" });
  const runtime = createRuntime({ db: handle.db, dwar: mockDwar({}), yaad: mockYaad(), ghar: mockGhar(), nas, config, log: silentLog });

  const sent = await send(runtime, agentId, { to: "ankur", content: "your report", attachments: ["/var/home/dadi/report.md"] });
  assert.equal(sent.isError, false, sent.content);
  const [row] = await handle.db.select().from(attachments).where(eq(attachments.filename, "report.md"));
  assert.ok(row?.path);
  assert.equal(nas.files.get(row.path)?.toString(), "# Title\nbody\n");
  nas.files.set("/var/home/dadi/report.md", Buffer.from("changed later"));
  assert.equal(nas.files.get(row.path)?.toString(), "# Title\nbody\n", "the copy is a snapshot");
  assert.notEqual(row.messageId, null);

  const relative = await send(runtime, agentId, { to: "ankur", content: "again", attachments: ["report.md"] });
  assert.equal(relative.isError, true);
});

test("the gates are gone: no status is required, a second progress line goes, and a spawned agent can be sent to", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ob-gates", systemPrompt: "agent" });
  const parentId = await insertAgent(handle.db, { id: "ob-requester", systemPrompt: "requester" });
  const childId = await insertAgent(handle.db, { id: "ob-child", systemPrompt: "child", parentAgentId: agentId });
  const { runtime } = runtimeWith();

  await deliverAgentMessage(quietDeps(runtime), { fromAgentId: parentId, toAgentId: agentId, content: "check the page" });
  assert.equal((await send(runtime, agentId, { to: parentId, content: "working on it" })).isError, false);
  assert.equal((await send(runtime, agentId, { to: parentId, content: "one update", status: "running" })).isError, false);
  assert.equal((await send(runtime, agentId, { to: parentId, content: "another update", status: "running" })).isError, false);
  assert.equal((await send(runtime, agentId, { to: "ankur", content: "a result for someone with no job", status: "done" })).isError, false);
  assert.equal((await send(runtime, agentId, { to: childId, content: "go on" })).isError, false);
  assert.equal((await send(runtime, agentId, { to: "Ankur Desai", content: "hi" })).isError, true);
  await runtime.waitUntilIdle();
});

test("a status on send still records the job: done closes it", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ob-result", systemPrompt: "agent" });
  const { runtime } = runtimeWith();

  await deliverUserMessage(quietDeps(runtime), agentId, "find my exam times");
  assert.equal((await send(runtime, agentId, { to: "ankur", content: "Wed 1:00 PM", status: "done" })).isError, false);
  const [job] = await handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
  assert.equal(job?.state, "done");
});

test("a process lane that yields with a work message waiting is asked again, then fails loudly and the row is recorded as failed", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ob-stuck", systemPrompt: "agent" });
  const { dwar, runtime } = runtimeWith(async () => yieldTurn("c-yield"));

  const made = await message(runtime, agentId, { to: "ankur", content: "never sent" });
  assert.equal(made.isError, false, made.content);
  await runtime.waitUntilIdle();

  assert.equal(dwar.processCalls.length, 4, "one call and three reminders");
  assert.match(JSON.stringify(dwar.processCalls[1]!.messages), /Messages from your work lane are still waiting/);
  const [row] = await handle.db.select().from(outbox).where(eq(outbox.agentId, agentId));
  assert.equal(row?.state, "failed");
  assert.match(row?.reason ?? "", /still waiting/);
  assert.equal(runtime.steer.hasItems(agentId), true, "the work lane is told it was not sent");
  assert.equal((await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId))).length, 0);
});

test("the reply to a message marked expects_reply wakes the work lane, not the process lane", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ob-asker", systemPrompt: "agent" });
  const askedId = await insertAgent(handle.db, { id: "ob-asked", systemPrompt: "asked" });
  let sent = false;
  const { dwar, runtime } = runtimeWith(async (request) => {
    if (!sent && JSON.stringify(request.messages).includes("[Messages from work]")) {
      sent = true;
      return toolUse(SEND, { to: askedId, content: "which semester?" }, "c-send");
    }
    return yieldTurn("c-yield");
  });

  const made = await message(runtime, agentId, { to: askedId, content: "which semester?", expects_reply: true });
  assert.equal(made.isError, false, made.content);
  await runtime.waitUntilIdle();
  const [row] = await handle.db.select().from(outbox).where(eq(outbox.agentId, agentId));
  assert.equal(row?.state, "sent");
  assert.equal(row?.expectsReply, true);
  const workBefore = dwar.workCalls.length;
  const processBefore = dwar.processCalls.length;

  await deliverAgentMessage(
    { db: handle.db, transcript: runtime.transcript, events: runtime.events, enqueueProcess: runtime.enqueueProcess, enqueueWork: runtime.enqueueWork },
    { fromAgentId: askedId, toAgentId: agentId, content: "fall 2026" },
  );
  await runtime.waitUntilIdle();

  assert.ok(dwar.workCalls.length > workBefore, "the reply woke the work lane");
  assert.equal(dwar.processCalls.length, processBefore, "the process lane did not wake");
  const [after] = await handle.db.select().from(outbox).where(eq(outbox.agentId, agentId));
  assert.equal(after?.expectsReply, false, "the wait ends with the first reply");
});

test("a message that is not a reply wakes the process lane, even from an agent this agent spawned", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ob-parent", systemPrompt: "agent" });
  const childId = await insertAgent(handle.db, { id: "ob-kid", systemPrompt: "kid", parentAgentId: agentId });
  const { dwar, runtime } = runtimeWith();

  await deliverAgentMessage(
    { db: handle.db, transcript: runtime.transcript, events: runtime.events, enqueueProcess: runtime.enqueueProcess, enqueueWork: runtime.enqueueWork },
    { fromAgentId: childId, toAgentId: agentId, content: "result" },
  );
  await runtime.waitUntilIdle();
  assert.ok(dwar.processCalls.length >= 1);
  assert.equal(dwar.workCalls.length, 0);
});

test("boot recovery wakes the process lane of an agent with a work message still waiting", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "ob-boot", systemPrompt: "agent" });
  const { runtime } = runtimeWith();
  await queueOutbox(handle.db, { agentId, to: null, content: "left over", attachmentIds: [], expectsReply: false });

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
