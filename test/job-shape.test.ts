import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { migrate } from "../src/db/migrate.js";
import { writeAgentLog } from "../src/db/logs.js";
import { awaitingReply, insertDeliveredOutbox } from "../src/db/outbox.js";
import { currentRequester, hydrateTranscript } from "../src/db/messages.js";
import { insertWake } from "../src/db/wakes.js";
import { messages, outbox, scheduledMessages, watches } from "../src/db/schema.js";
import { deliverAgentMessage, deliverUserMessage } from "../src/runtime/deliver.js";
import { createRuntime, type Runtime } from "../src/runtime/engine.js";
import { EventBus } from "../src/runtime/events.js";
import { PICKUP_TEXT, sendPickups } from "../src/runtime/pickups.js";
import { NOT_A_REPLY } from "../src/runtime/process.js";
import { executeTool } from "../src/runtime/tools.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { recordWatch, watchOf } from "../src/runtime/watches.js";
import type { Config } from "../src/config.js";
import type { DwarChatRequest, DwarChatResponse } from "../src/types/domain.js";
import { MODIFY_AGENT_PROMPT, QUEUE_MESSAGE, SEND_MESSAGE, WAIT } from "../src/types/domain.js";
import {
  FLAGS_OFF,
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
  withRuntime,
  yieldTurn,
} from "./helpers.js";

const base = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(base);
});

after(async () => {
  await handle.close();
});

/** A runtime under `config` whose process lane answers each call with the next of `turns`, then yields. */
function scripted(config: Config, turns: Array<(request: DwarChatRequest) => DwarChatResponse | Promise<DwarChatResponse>>) {
  let n = 0;
  const dwar = mockDwar({
    process: async (request) => {
      const next = turns[n];
      n += 1;
      return next === undefined ? yieldTurn(`y${n}`) : next(request);
    },
  });
  const runtime = createRuntime({ db: handle.db, dwar, yaad: mockYaad(), ghar: mockGhar(), nas: mockNas(), config, log: silentLog });
  return { dwar, runtime };
}

/** Deliveries that queue no lane run, so a test drives what wakes itself. */
function quietDeps(transcript: TranscriptStore, woke: string[] = []) {
  return {
    db: handle.db,
    transcript,
    events: new EventBus(silentLog),
    enqueueProcess: (agentId: string) => {
      woke.push(`${agentId}:process`);
      return randomUUID();
    },
    enqueueWork: (agentId: string) => {
      woke.push(`${agentId}:work`);
      return randomUUID();
    },
  };
}

/** The runtime's own delivery deps, so a delivery queues real lane runs. */
function runtimeDeps(runtime: Runtime) {
  return {
    db: handle.db,
    transcript: runtime.transcript,
    events: runtime.events,
    enqueueProcess: runtime.enqueueProcess,
    enqueueWork: runtime.enqueueWork,
  };
}

/** A schedule from `from` to `to`, due a minute ago, repeating daily or firing once. */
async function dueSchedule(from: string, to: string, content: string, intervalMinutes: number | null): Promise<string> {
  const id = randomUUID();
  await handle.db.insert(scheduledMessages).values({ id, fromAgentId: from, toAgentId: to, content, runAt: new Date(Date.now() - 60_000), intervalMinutes });
  return id;
}

/** A process-lane turn of one send_message. */
function send(input: Record<string, unknown>, id: string): () => DwarChatResponse {
  return () => toolUse(SEND_MESSAGE, input, id);
}

test("a repeating schedule's trigger opens a silent routine: [Routine] label, no requester, no agent messages, Ankur once with needs_input", async () => {
  await resetRuntime(handle.sql, handle.db, base);
  const author = await insertAgent(handle.db, { id: "rt-author", systemPrompt: "author" });
  const asker = await insertAgent(handle.db, { id: "rt-asker", systemPrompt: "asker" });
  const target = await insertAgent(handle.db, { id: "rt-target", systemPrompt: "target", parentAgentId: author });
  const config = withRuntime(base, { ...FLAGS_OFF, routine_silence: true });
  const { dwar, runtime } = scripted(config, [
    send({ to: author, content: "Nothing due today." }, "s1"),
    send({ to: "ankur", content: "Kritik closes tonight and needs your essay." }, "s2"),
    send({ to: "ankur", content: "Kritik closes tonight and needs your essay.", status: "needs_input" }, "s3"),
    send({ to: "ankur", content: "Also the quiz.", status: "blocked" }, "s4"),
  ]);
  await deliverAgentMessage(quietDeps(runtime.transcript), { fromAgentId: asker, toAgentId: target, content: "what is due this week?" });
  const scheduleId = await dueSchedule(author, target, "Morning check: re-read and record what is due today.", 1440);

  await runtime.scheduler.tick();
  await runtime.waitUntilIdle();

  const routineCalls = dwar.processCalls;
  const seen = JSON.stringify(routineCalls[0]!.messages);
  assert.match(seen, new RegExp(`\\[Routine · ${scheduleId} · `));
  assert.doesNotMatch(seen, /\[From: rt-author/);
  assert.equal(await currentRequester(handle.db, target), asker, "the trigger made no one a requester");
  const results = JSON.stringify(routineCalls.map((request) => request.messages.at(-2)));
  assert.match(results, /a scheduled routine is silent/);
  assert.match(results, /already has one for him/);
  const sent = await handle.db.select().from(messages).where(eq(messages.fromAgentId, target));
  assert.deepEqual(
    sent.map((row) => [row.toAgentId, row.status]),
    [[null, "needs_input"]],
    "only the one needs_input message to Ankur went out",
  );
});

test("a one-shot schedule is a deferred job, not a routine: its wake may message the author", async () => {
  await resetRuntime(handle.sql, handle.db, base);
  const author = await insertAgent(handle.db, { id: "os-author", systemPrompt: "author" });
  const target = await insertAgent(handle.db, { id: "os-target", systemPrompt: "target" });
  const config = withRuntime(base, { ...FLAGS_OFF, routine_silence: true });
  const { dwar, runtime } = scripted(config, [send({ to: author, content: "Retried the portal: still Processing." }, "s1")]);
  await dueSchedule(author, target, "Retry the RCPD portal read.", null);

  await runtime.scheduler.tick();
  await runtime.waitUntilIdle();

  assert.match(JSON.stringify(dwar.processCalls[0]!.messages), /\[From: os-author/);
  const sent = await handle.db.select().from(messages).where(and(eq(messages.fromAgentId, target), eq(messages.toAgentId, author)));
  assert.equal(sent.length, 1);
});

test("a routine wake that Ankur's message joins is a job again: its sends are no longer held", async () => {
  await resetRuntime(handle.sql, handle.db, base);
  const author = await insertAgent(handle.db, { id: "jn-author", systemPrompt: "author" });
  const target = await insertAgent(handle.db, { id: "jn-target", systemPrompt: "target" });
  const config = withRuntime(base, { ...FLAGS_OFF, routine_silence: true });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let called: () => void = () => {};
  const firstCall = new Promise<void>((resolve) => {
    called = resolve;
  });
  const { runtime } = scripted(config, [
    async () => {
      called();
      await gate;
      return toolUse(SEND_MESSAGE, { to: "ankur", content: "Nothing is due today." }, "s1");
    },
    send({ to: "ankur", content: "Nothing is due today." }, "s2"),
  ]);
  await dueSchedule(author, target, "Morning check.", 1440);

  const ticked = runtime.scheduler.tick();
  await firstCall;
  await deliverUserMessage(runtimeDeps(runtime), target, "anything due today?");
  release();
  await ticked;
  await runtime.waitUntilIdle();

  const toAnkur = await handle.db.select().from(messages).where(and(eq(messages.fromAgentId, target)));
  assert.deepEqual(
    toAnkur.map((row) => [row.toAgentId, row.content, row.status]),
    [[null, "Nothing is due today.", null]],
    "after the race refusal for his unread message, a send with no status went out: the wake is a job now",
  );
});

test("hydrating marks the trigger of a schedule that still repeats as its routine", async () => {
  await resetRuntime(handle.sql, handle.db, base);
  const author = await insertAgent(handle.db, { id: "hy-author", systemPrompt: "author" });
  const target = await insertAgent(handle.db, { id: "hy-target", systemPrompt: "target" });
  const scheduleId = randomUUID();
  await handle.db.insert(scheduledMessages).values({ id: scheduleId, fromAgentId: author, toAgentId: target, content: "check", runAt: new Date(Date.now() + 86_400_000), intervalMinutes: 1440 });
  const trigger = await deliverAgentMessage(quietDeps(new TranscriptStore()), { fromAgentId: author, toAgentId: target, content: "check", scheduleId, routine: scheduleId, scheduled: true });
  await insertWake(handle.db, { id: randomUUID(), agentId: target, origin: { kind: "schedule", ref: scheduleId, openedByMessageId: trigger.id! } });

  const transcript = new TranscriptStore();
  await hydrateTranscript(handle.db, transcript);
  assert.equal(transcript.transcriptFor(target).at(-1)?.routine, scheduleId);
  assert.equal(await currentRequester(handle.db, target), null, "no one opened a line: the target answers to its parent, the router");
});

test("under direct_agent_messages the work lane's message to an agent goes out at once, recorded sent, and the process lane never sees it", async () => {
  await resetRuntime(handle.sql, handle.db, base);
  const agentId = await insertAgent(handle.db, { id: "dm-agent", systemPrompt: "agent" });
  const peerId = await insertAgent(handle.db, { id: "dm-peer", systemPrompt: "peer" });
  const config = withRuntime(base, { ...FLAGS_OFF, direct_agent_messages: true });
  const { dwar, runtime } = scripted(config, []);

  const made = await executeTool(runtime.toolContext(agentId, "work"), {
    type: "tool_use",
    id: "q1",
    name: QUEUE_MESSAGE,
    input: { to: peerId, content: "What is due tonight?", expects_reply: true },
  });
  assert.equal(made.isError, false, made.content);
  await runtime.waitUntilIdle();

  const [row] = await handle.db.select().from(outbox).where(eq(outbox.agentId, agentId));
  const [message] = await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId));
  assert.equal(row?.state, "sent");
  assert.equal(row?.messageId, message?.id);
  assert.equal(message?.toAgentId, peerId);
  assert.equal(runtime.transcript.transcriptFor(agentId).at(-1)?.sentBy, "work");
  assert.ok(await awaitingReply(handle.db, agentId, peerId), "the reply it expects wakes the work lane");
  assert.equal(dwar.processCalls.some((request) => JSON.stringify(request.messages).includes("[Messages from work]")), false);
});

test("under direct_agent_messages the process lane's new ask to an agent is refused; its reply to one that wrote goes", async () => {
  await resetRuntime(handle.sql, handle.db, base);
  const agentId = await insertAgent(handle.db, { id: "ro-agent", systemPrompt: "agent" });
  const askerId = await insertAgent(handle.db, { id: "ro-asker", systemPrompt: "asker" });
  const otherId = await insertAgent(handle.db, { id: "ro-other", systemPrompt: "other" });
  const config = withRuntime(base, { ...FLAGS_OFF, direct_agent_messages: true });
  const { dwar, runtime } = scripted(config, [
    send({ to: otherId, content: "Can you check the final-exam clash?" }, "s1"),
    send({ to: askerId, content: "Nothing due tonight." }, "s2"),
  ]);
  await deliverAgentMessage(runtimeDeps(runtime), { fromAgentId: askerId, toAgentId: agentId, content: "anything due tonight?" });
  await runtime.waitUntilIdle();

  assert.ok(JSON.stringify(dwar.processCalls[1]!.messages).includes(NOT_A_REPLY));
  const sent = await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId));
  assert.deepEqual(sent.map((row) => row.toAgentId), [askerId]);
});

test("expects_reply on a message to Ankur is dropped, so his next message reaches the process lane", async () => {
  await resetRuntime(handle.sql, handle.db, base);
  const agentId = await insertAgent(handle.db, { id: "er-agent", systemPrompt: "agent" });
  const { runtime } = scripted(withRuntime(base, FLAGS_OFF), [send({ to: "ankur", content: "Four items are due tonight." }, "s1")]);
  const made = await executeTool(runtime.toolContext(agentId, "work"), {
    type: "tool_use",
    id: "q1",
    name: QUEUE_MESSAGE,
    input: { to: "ankur", content: "Four items are due tonight.", expects_reply: true },
  });
  assert.equal((JSON.parse(made.content) as { expects_reply: boolean }).expects_reply, false);
  await runtime.waitUntilIdle();
  const [row] = await handle.db.select().from(outbox).where(eq(outbox.agentId, agentId));
  assert.equal(row?.state, "sent");
  assert.equal(row?.expectsReply, false);
  assert.equal(await awaitingReply(handle.db, agentId, null), false);
});

test("a progress line wakes no one and leaves the recipient's wait and awaited reply standing; the result wakes its work lane", async () => {
  await resetRuntime(handle.sql, handle.db, base);
  const parentId = await insertAgent(handle.db, { id: "pl-parent", systemPrompt: "parent" });
  const childId = await insertAgent(handle.db, { id: "pl-child", systemPrompt: "child" });
  await insertDeliveredOutbox(handle.db, { agentId: parentId, to: childId, content: "due tonight?", attachmentIds: [], expectsReply: true });
  await recordWatch(handle.db, parentId, [childId], 30);
  const woke: string[] = [];
  const deps = quietDeps(new TranscriptStore(), woke);

  await deliverAgentMessage(deps, { fromAgentId: childId, toAgentId: parentId, content: "Reading D2L now.", status: "running" });
  assert.deepEqual(woke, []);
  assert.ok(await awaitingReply(handle.db, parentId, childId));
  assert.ok((await watchOf(handle.db, parentId)) !== undefined);

  await deliverAgentMessage(deps, { fromAgentId: childId, toAgentId: parentId, content: "Module 8 quiz, 11:59 PM.", status: "done" });
  assert.deepEqual(woke, [`${parentId}:work`]);
  assert.equal(await awaitingReply(handle.db, parentId, childId), false);
  assert.equal((await handle.db.select().from(watches).where(eq(watches.agentId, parentId))).length, 1, "the awaited reply woke it; the watch goes when the lane runs");
});

test("hath picks up Ankur's job once, only after the work lane acted on it and only when the agent has not answered", async () => {
  await resetRuntime(handle.sql, handle.db, base);
  const worked = await insertAgent(handle.db, { id: "pu-worked", systemPrompt: "agent" });
  const idle = await insertAgent(handle.db, { id: "pu-idle", systemPrompt: "agent" });
  const answered = await insertAgent(handle.db, { id: "pu-answered", systemPrompt: "agent" });
  const transcript = new TranscriptStore();
  const deps = quietDeps(transcript);
  for (const agentId of [worked, idle, answered]) {
    await deliverUserMessage(deps, agentId, "what is due tonight?");
  }
  for (const agentId of [worked, answered]) {
    await writeAgentLog(handle.db, { agentId, lane: "work", event: "response", payload: {} });
  }
  await deliverAgentMessage(deps, { fromAgentId: answered, toAgentId: null, content: "Nothing due tonight." });

  const afterMs = base.runtime.pickup_delay_s * 1000;
  const soon = new Date(Date.now() + afterMs / 2);
  assert.equal(await sendPickups(deps, soon, afterMs), 0, "nothing is overdue yet");
  const late = new Date(Date.now() + afterMs + 5_000);
  assert.equal(await sendPickups(deps, late, afterMs), 1);
  assert.equal(await sendPickups(deps, late, afterMs), 0, "one pickup per message");

  const [pickup] = await handle.db.select().from(messages).where(and(eq(messages.fromAgentId, worked)));
  assert.equal(pickup?.content, PICKUP_TEXT);
  assert.equal(pickup?.toAgentId, null);
  assert.equal(pickup?.status, "running");
  assert.equal(transcript.transcriptFor(worked).at(-1)?.sentBy, "hath");
  assert.equal((await handle.db.select().from(messages).where(eq(messages.fromAgentId, idle))).length, 0);
});

test("with status_job_ledger the status lists the job's asks with who answered", async () => {
  await resetRuntime(handle.sql, handle.db, base);
  const agentId = await insertAgent(handle.db, { id: "lg-agent", systemPrompt: "agent" });
  const doneId = await insertAgent(handle.db, { id: "lg-done", systemPrompt: "class" });
  const slowId = await insertAgent(handle.db, { id: "lg-slow", systemPrompt: "class" });
  const { runtime } = scripted(withRuntime(base, { ...FLAGS_OFF, status_job_ledger: true }), []);
  const deps = quietDeps(runtime.transcript);
  await deliverUserMessage(deps, agentId, "what is due tonight?");
  await deliverAgentMessage(deps, { fromAgentId: agentId, toAgentId: doneId, content: "due tonight?" });
  await deliverAgentMessage(deps, { fromAgentId: agentId, toAgentId: slowId, content: "due tonight?" });
  const reply = await deliverAgentMessage(deps, { fromAgentId: doneId, toAgentId: agentId, content: "Module 8 quiz" });

  const status = await runtime.statusOf(agentId);
  assert.deepEqual(
    status.ledger?.asks.map((ask) => [ask.to, ask.answered_seq]),
    [
      [doneId, reply.seq],
      [slowId, null],
    ],
  );
  const off = await scripted(withRuntime(base, FLAGS_OFF), []).runtime.statusOf(agentId);
  assert.equal(off.ledger, null);
});

test("under direct_ankur_messages the work lane's message to Ankur goes out at once with its status; a progress line, or a date with no weekday, is refused", async () => {
  await resetRuntime(handle.sql, handle.db, base);
  const agentId = await insertAgent(handle.db, { id: "da-agent", systemPrompt: "agent" });
  const config = withRuntime(base, { ...FLAGS_OFF, direct_ankur_messages: true, hath_pickups: true, weekday_guard: true });
  const { dwar, runtime } = scripted(config, []);
  const queue = (input: Record<string, unknown>, id: string) =>
    executeTool(runtime.toolContext(agentId, "work"), { type: "tool_use", id, name: QUEUE_MESSAGE, input });

  assert.match((await queue({ to: "ankur", content: "Reading D2L.", status: "running" }, "q1")).content, /hath sends Ankur the pickup/);
  assert.match((await queue({ to: "ankur", content: "Due Nov 18.", status: "done" }, "q2")).content, /write the weekday/);
  const sent = await queue({ to: "ankur", content: "Due Wed Nov 18.", status: "done" }, "q3");
  assert.equal(sent.isError, false, sent.content);
  await runtime.waitUntilIdle();

  const rows = await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId));
  assert.deepEqual(rows.map((row) => [row.toAgentId, row.status, row.content]), [[null, "done", "Due Wed Nov 18."]]);
  assert.equal(runtime.transcript.transcriptFor(agentId).at(-1)?.sentBy, "work");
  assert.equal(dwar.processCalls.length, 1, "the process lane saw it as a send by the work lane, and relayed nothing");
});

test("a wait on a job from Ankur ends no later than question_answer_minutes after his message, and its timeout says to answer now", async () => {
  await resetRuntime(handle.sql, handle.db, base);
  const agentId = await insertAgent(handle.db, { id: "qw-agent", systemPrompt: "agent" });
  const classId = await insertAgent(handle.db, { id: "qw-class", systemPrompt: "class" });
  const config = withRuntime(base, { ...FLAGS_OFF, question_answer_minutes: 5 });
  const { runtime } = scripted(config, []);
  await deliverUserMessage(quietDeps(runtime.transcript), agentId, "what is due tonight?");

  const waited = await executeTool(runtime.toolContext(agentId, "work"), { type: "tool_use", id: "w1", name: WAIT, input: { on: classId, timeout_minutes: 20 } });
  const dueAt = new Date((JSON.parse(waited.content) as { wakes_by: string }).wakes_by).getTime();
  assert.ok(dueAt <= Date.now() + 5 * 60_000, "capped at five minutes from his message");
  assert.match(waited.content, /Shortened to/);

  await deliverAgentMessage(quietDeps(runtime.transcript), { fromAgentId: agentId, toAgentId: classId, content: "due tonight?" });
  await handle.db.update(watches).set({ dueAt: new Date(Date.now() - 1000) }).where(eq(watches.agentId, agentId));
  await runtime.scheduler.tick();
  await runtime.waitUntilIdle();
  assert.match(JSON.stringify(runtime.transcript.transcriptFor(agentId).at(-1)), /Answer Ankur now with what you have/);
});

test("modify_agent_prompt refuses an edit that adds a clock time, and allows one that keeps a time already there", async () => {
  await resetRuntime(handle.sql, handle.db, base);
  const parentId = await insertAgent(handle.db, { id: "mp-parent", systemPrompt: "parent" });
  const childId = await insertAgent(handle.db, { id: "mp-child", systemPrompt: "Check at 9:00 AM. Own the course.", parentAgentId: parentId });
  const { runtime } = scripted(withRuntime(base, FLAGS_OFF), []);
  const edit = (id: string, newString: string) =>
    executeTool(runtime.toolContext(parentId, "work"), {
      type: "tool_use",
      id,
      name: MODIFY_AGENT_PROMPT,
      input: { agent_id: childId, edits: [{ old_string: "Own the course.", new_string: newString }] },
    });

  const refused = await edit("m1", "Each morning at 7:00 AM ET, finish the day's work.");
  assert.equal(refused.isError, true);
  assert.match(refused.content, /times live in schedules, not prompts/);
  const allowed = await edit("m2", "Own the course and its notes.");
  assert.equal(allowed.isError, false, allowed.content);
});
