import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { hydrateTranscript, insertMessage, insertUtterance, listHumanMessages, listThreads, NO_ATTACHMENTS } from "../src/db/messages.js";
import { agentLogs, agents, attachments, jobs, messages } from "../src/db/schema.js";
import { writeAgentLog } from "../src/db/logs.js";
import { arrivalsSince, assembleContext, type ThreadWindow, windowStart } from "../src/runtime/context.js";
import { deliverAgentMessage, deliverUserMessage } from "../src/runtime/deliver.js";
import { createRuntime } from "../src/runtime/engine.js";
import { EventBus } from "../src/runtime/events.js";
import { executeTool } from "../src/runtime/tools.js";
import { AGENT_MESSAGE_MAX_CHARS } from "../src/tools/shared.js";
import type { WakeOrigin } from "../src/types/domain.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { DATA_CHARS_PER_TOKEN, PROSE_CHARS_PER_TOKEN } from "../src/runtime/wake.js";
import {
  endTurn,
  
  insertAgent,
  mockDwar,
  mockGhar,
  mockNas,
  mockYaad,
  openTestDb,
  resetRuntime,
  roomyWakeLimits,
  silentLog,
  testConfig,
  wideWindow,
  loopHooks,
} from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
  await resetRuntime(handle.sql, handle.db, config);
});

after(async () => {
  await handle.close();
});

function deliverDeps(transcript: TranscriptStore) {
  return {
    db: handle.db,
    transcript,
    events: new EventBus(silentLog),
    answerByMinutes: 5,
    enqueue: () => randomUUID(),
    preempt: () => {},
  };
}

test("deliverUserMessage persists a messages row stamped with the wake it opened and writes no log row", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, {
    name: "persist-worker",
    systemPrompt: "you persist",
  });
  const transcript = new TranscriptStore();
  const wakeId = randomUUID();
  let origin: WakeOrigin | undefined;
  const row = await deliverUserMessage(
    {
      ...deliverDeps(transcript),
      answerByMinutes: 5,
      enqueue: (_agentId, _reason, given) => {
        origin = given;
        return wakeId;
      },
    },
    agentId,
    "hello durable",
  );
  assert.ok(row.id);
  assert.ok(row.seq > 0);
  const stored = await handle.db.select().from(messages).where(eq(messages.id, row.id!));
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.content, "hello durable");
  assert.equal(stored[0]?.fromAgentId, null);
  assert.equal(stored[0]?.toAgentId, agentId);
  assert.equal(stored[0]?.wakeId, wakeId);
  const [job] = await handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
  assert.deepEqual(origin, { kind: "message", ref: null, openedByMessageId: row.id, jobId: job?.id, jobIsNew: true });
  assert.equal(stored[0]?.jobId, job?.id);
  assert.equal((await handle.db.select().from(agentLogs)).length, 0);
});

test("a message that wakes no one has a null wake_id", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const fromId = await insertAgent(handle.db, { name: "quiet-from", systemPrompt: "from" });
  const toId = await insertAgent(handle.db, { name: "quiet-to", systemPrompt: "to" });
  const row = await deliverAgentMessage(deliverDeps(new TranscriptStore()), {
    fromAgentId: fromId,
    toAgentId: toId,
    content: "no wake",
    wake: false,
  });
  const [stored] = await handle.db.select().from(messages).where(eq(messages.id, row.id!));
  assert.equal(stored?.wakeId, null);
});

test("an utterance is stored apart from every conversation and never hydrates a transcript", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { name: "utterance-agent", systemPrompt: "agent" });
  await insertUtterance(handle.db, "tell utterance-agent hello");
  const [stored] = await handle.db.select().from(messages);
  assert.equal(stored?.kind, "utterance");
  assert.equal(stored?.fromAgentId, null);
  assert.equal(stored?.toAgentId, null);
  assert.deepEqual(await listHumanMessages(handle.db, agentId, { limit: 50 }), []);
  assert.deepEqual(await listThreads(handle.db), []);
  const transcript = new TranscriptStore();
  assert.equal(await hydrateTranscript(handle.db, transcript), 0);
});

test("windowStart keeps a thread under the window whole", () => {
  assert.equal(windowStart([100, 100, 100], { chars: 1000, stepChars: 300 }), 0);
  assert.equal(windowStart([], { chars: 1000, stepChars: 300 }), 0);
});

test("windowStart moves the start in steps, not with every message", () => {
  const window = { chars: 1000, stepChars: 300 };
  const sizes = Array.from({ length: 12 }, () => 100);
  assert.equal(windowStart(sizes, window), 3);
  assert.equal(windowStart([...sizes, 100], window), 3);
  assert.equal(windowStart([...sizes, 100, 100], window), 6);
});

test("windowStart always shows the newest message, even when it alone overflows", () => {
  const window = { chars: 1000, stepChars: 300 };
  assert.equal(windowStart([5000], window), 0);
  assert.equal(windowStart([100, 5000], window), 1);
});

test("assembleContext keeps an open job's messages whole and cuts a rolling window of the rest", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, {
    name: "window-worker",
    systemPrompt: "system",
  });
  const transcript = new TranscriptStore();
  const deps = deliverDeps(transcript);
  for (let i = 0; i < 6; i++) {
    await deliverUserMessage(deps, agentId, `m-${i} ${"x".repeat(100)}`);
  }
  const assemble = (window: ThreadWindow) =>
    assembleContext({
      db: handle.db,
      serviceRoot: config.serviceRoot,
      agentId,
      transcript,
      window,
      continuation: null,
    });

  const whole = await assemble(wideWindow);
  const thread = whole.thread;
  assert.equal(thread.length, 6);

  const narrow = await assemble({ chars: 500, stepChars: 200, budgetTokens: 10_000_000 });
  assert.deepEqual(narrow.thread, thread, "the messages of an open job are shown whole however narrow the window");

  await handle.sql`UPDATE jobs SET state = 'done' WHERE agent_id = ${agentId}`;
  const closed = await assemble({ chars: 500, stepChars: 200, budgetTokens: 10_000_000 });
  const sizes = thread.map((m) => String(m.content).length);
  const start = windowStart(sizes, { chars: 500, stepChars: 125 });
  assert.ok(start > 0);
  assert.deepEqual(closed.thread, thread.slice(start));
  assert.match(String(closed.thread.at(-1)?.content), /\nm-5 /);
  assert.equal(closed.throughSeq, whole.throughSeq);
});

test("a continuation's thread stops at the job's last logged step, and what arrived after it comes folded as arrived", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { name: "split-worker", systemPrompt: "system" });
  const transcript = new TranscriptStore();
  const deps = deliverDeps(transcript);
  await deliverUserMessage(deps, agentId, "read D2L for the project dates");
  const [job] = await handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
  const wakeId = randomUUID();
  await handle.db.insert(agentLogs).values([
    { id: randomUUID(), agentId, jobId: job!.id, wakeId, event: "response", payload: { provider: "anthropic", content: [{ type: "tool_use", id: "s1", name: "steer_browser", input: { message: "read D2L" } }] } },
    { id: randomUUID(), agentId, jobId: job!.id, wakeId, event: "tool_result", payload: { tool_use_id: "s1", content: "{\"id\":\"task/browser/1\"}", is_error: false } },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await deliverAgentMessage(deps, { fromAgentId: agentId, toAgentId: agentId, content: "Helper finished (task/browser/1):\nProject 2 is due Nov 20.", notice: "helper", jobId: job!.id });

  const context = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId,
    transcript,
    window: wideWindow,
    continuation: { wakeId: randomUUID(), jobId: job!.id, filesDir: "/files" },
  });

  assert.equal(context.continued?.length, 2, "the job's earlier step and its result");
  const before = JSON.stringify(context.thread);
  assert.match(before, /read D2L for the project dates/);
  assert.doesNotMatch(before, /Helper finished/);
  assert.equal(context.arrived?.role, "user");
  assert.match(String(context.arrived?.content), /^\[Arrived since your last step\]\n\n\[Notice from hath[^\n]*\n[^\n]*Helper finished \(task\/browser\/1\):\nProject 2 is due Nov 20\./);

  const fresh = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId,
    transcript,
    window: wideWindow,
    continuation: null,
  });
  assert.equal(fresh.arrived, undefined, "a wake that continues no job keeps its whole thread in place");
  assert.match(JSON.stringify(fresh.thread), /Helper finished/);
});

test("assembleContext shortens the window to the room its token budget leaves after the system and tools", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, {
    name: "budget-worker",
    systemPrompt: "system",
  });
  const transcript = new TranscriptStore();
  const deps = deliverDeps(transcript);
  for (let i = 0; i < 6; i++) {
    await deliverUserMessage(deps, agentId, `m-${i} ${"x".repeat(100)}`);
  }
  const assemble = (budgetTokens: number) =>
    assembleContext({
      db: handle.db,
      serviceRoot: config.serviceRoot,
      agentId,
      transcript,
      window: { ...wideWindow, budgetTokens },
      continuation: null,
    });

  const whole = await assemble(wideWindow.budgetTokens);
  const thread = whole.thread;
  assert.equal(thread.length, 6);
  const fixedTokens =
    Math.ceil(whole.system.length / PROSE_CHARS_PER_TOKEN) +
    Math.ceil(JSON.stringify(whole.tools).length / DATA_CHARS_PER_TOKEN);

  const full = await assemble(fixedTokens);
  assert.deepEqual(full.thread, thread.slice(-1), "even an open job's messages give way to the room the ceiling leaves");
});

test("messages arriving mid-wake join the wake after it and never rewrite earlier turns", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, {
    name: "arrival-worker",
    systemPrompt: "system",
  });
  const transcript = new TranscriptStore();
  const deps = deliverDeps(transcript);
  await deliverUserMessage(deps, agentId, "find Oliver Chen");

  const { runAgentLoop } = await import("../src/runtime/loop.js");
  const { Wake } = await import("../src/runtime/wake.js");
  const requests: { messages: unknown[] }[] = [];
  let turn = 0;
  await runAgentLoop({
    ...loopHooks(),
    agentId,
    wake: new Wake(roomyWakeLimits),
    toolChoice: "auto",
    tagTurns: true,
    assemble: () =>
      assembleContext({
        window: wideWindow,
        continuation: null,
        db: handle.db,
        serviceRoot: config.serviceRoot,
        agentId,
        transcript,
      }),
    arrivalsSince: (afterSeq) => arrivalsSince(transcript, agentId, afterSeq),
    call: async (request) => {
      requests.push(structuredClone(request));
      turn += 1;
      if (turn === 1) {
        await deliverUserMessage(deps, agentId, "status?");
        await deliverAgentMessage(deps, {
          fromAgentId: agentId,
          toAgentId: null,
          content: "on it",
        });
      }
      const name = turn < 3 ? "get_device" : "yield";
      return {
        provider: "anthropic" as const,
        content: [{ type: "tool_use" as const, id: `c${turn}`, name, input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    },
    executeTool: async () => ({ content: "{}", isError: false, audit: {} }),
    logResponse: async () => {},
    logToolResult: async () => {},
  });

  assert.equal(requests.length, 3);
  const [first, second, third] = requests as { messages: { role: string; content: unknown }[] }[];
  assert.deepEqual(second!.messages.slice(0, first!.messages.length), first!.messages);
  assert.deepEqual(third!.messages.slice(0, second!.messages.length), second!.messages);
  const arrival = second!.messages.at(-1) as { role: string; content: unknown };
  assert.equal(arrival.role, "user");
  assert.ok(typeof arrival.content === "string");
  assert.ok(arrival.content.includes("status?"));
  assert.match(arrival.content, /· job #\d+\]/, "an arrival names its job");
  assert.ok(!arrival.content.includes("on it"), "the agent's own send is no arrival");
  assert.ok(first!.messages.every((m) => !JSON.stringify(m).includes("status?")));
});

test("hydrateTranscript restores durable rows into TranscriptStore", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, {
    name: "hydrate-worker",
    systemPrompt: "system",
  });
  const first = new TranscriptStore();
  await deliverUserMessage(deliverDeps(first), agentId, "before restart");
  await deliverAgentMessage(deliverDeps(first), {
    fromAgentId: agentId,
    toAgentId: null,
    content: "reply before restart",
  });

  const second = new TranscriptStore();
  const loaded = await hydrateTranscript(handle.db, second);
  assert.equal(loaded, 2);
  const entries = second.transcriptFor(agentId);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.content, "before restart");
  assert.equal(entries[1]?.content, "reply before restart");
});

test("GET /threads and GET /agents/:id/messages return human-thread history", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, {
    name: "api-worker",
    systemPrompt: "system",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas: mockNas(),
    runtime,
  });

  const post = await app.inject({
    method: "POST",
    url: "/messages",
    payload: { to_agent_id: agentId, content: "ping" },
  });
  assert.equal(post.statusCode, 201);
  const posted = post.json() as { seq: number };
  await deliverAgentMessage(
    {
      db: handle.db,
      transcript: runtime.transcript,
      events: runtime.events,
      answerByMinutes: 5,
      enqueue: runtime.enqueue,
      preempt: runtime.deliver.preempt,
    },
    { fromAgentId: agentId, toAgentId: null, content: "pong" },
  );

  const threadsRes = await app.inject({ method: "GET", url: "/threads" });
  assert.equal(threadsRes.statusCode, 200);
  const threadsBody = threadsRes.json() as {
    threads: Array<{
      agent_id: string;
      agent_name: string;
      last_message: string;
      from_user: boolean;
    }>;
  };
  const thread = threadsBody.threads.find((t) => t.agent_id === agentId);
  assert.ok(thread);
  assert.equal(thread.agent_name, "api-worker");
  assert.equal(thread.last_message, "pong");
  assert.equal(thread.from_user, false);

  const msgsRes = await app.inject({
    method: "GET",
    url: `/agents/${agentId}/messages`,
  });
  assert.equal(msgsRes.statusCode, 200);
  const msgsBody = msgsRes.json() as {
    messages: Array<{ content: string; seq: number }>;
  };
  assert.equal(msgsBody.messages.length, 2);
  assert.equal(msgsBody.messages[0]?.content, "ping");
  assert.equal(msgsBody.messages[1]?.content, "pong");

  const sinceRes = await app.inject({
    method: "GET",
    url: `/agents/${agentId}/messages?since_seq=${posted.seq}`,
  });
  assert.equal(sinceRes.statusCode, 200);
  const sinceBody = sinceRes.json() as { messages: Array<{ content: string }> };
  assert.equal(sinceBody.messages.length, 1);
  assert.equal(sinceBody.messages[0]?.content, "pong");

  await app.close();
});

test("listThreads helpers match HTTP shape; agent↔agent excluded from human thread", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const a = await insertAgent(handle.db, {
    name: "alpha",
    systemPrompt: "a",
  });
  const b = await insertAgent(handle.db, {
    name: "beta",
    systemPrompt: "b",
  });
  const transcript = new TranscriptStore();
  const deps = deliverDeps(transcript);
  await deliverUserMessage(deps, a, "hi alpha");
  await deliverAgentMessage(deps, {
    fromAgentId: a,
    toAgentId: b,
    content: "secret agent chat",
  });

  const threads = await listThreads(handle.db);
  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.agent_id, a);

  const human = await listHumanMessages(handle.db, a, { limit: 50 });
  assert.equal(human.length, 1);
  assert.equal(human[0]?.content, "hi alpha");

  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, a));
  assert.deepEqual(await listThreads(handle.db), []);
  assert.equal((await listHumanMessages(handle.db, a, { limit: 50 })).length, 1);
});

test("listHumanMessages without since_seq returns the newest rows oldest first", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const a = await insertAgent(handle.db, {
    name: "alpha",
    systemPrompt: "a",
  });
  const deps = deliverDeps(new TranscriptStore());
  for (const n of [1, 2, 3, 4, 5]) {
    await deliverUserMessage(deps, a, `m${n}`);
  }

  const latest = await listHumanMessages(handle.db, a, { limit: 3 });
  assert.deepEqual(latest.map((m) => m.content), ["m3", "m4", "m5"]);

  const all = await listHumanMessages(handle.db, a, { limit: 50 });
  const forward = await listHumanMessages(handle.db, a, { sinceSeq: all[0]!.seq, limit: 2 });
  assert.deepEqual(forward.map((m) => m.content), ["m2", "m3"]);
});

test("assembleContext injects agent id and parent routing for children", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, {
    id: "routing-parent",
    systemPrompt: "parent",
  });
  const childId = await insertAgent(handle.db, {
    id: "routing-child",
    systemPrompt: "child",
    parentAgentId: parentId,
  });
  const childCtx = await assembleContext({
    window: wideWindow,
    continuation: null,
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: childId,
    transcript: new TranscriptStore(),
  });
  assert.match(childCtx.system, /Your agent id is routing-child/);
  assert.match(childCtx.system, /Your parent is routing-parent/);

  const parentCtx = await assembleContext({
    window: wideWindow,
    continuation: null,
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: parentId,
    transcript: new TranscriptStore(),
  });
  assert.match(parentCtx.system, /Your agent id is routing-parent/);
  assert.match(parentCtx.system, /You are a root agent/);
});

test("child may still message and send to the user", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, {
    id: "msg-parent",
    systemPrompt: "parent",
  });
  const childId = await insertAgent(handle.db, {
    id: "msg-child",
    systemPrompt: "child",
    parentAgentId: parentId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  const send = await executeTool(runtime.toolContext(childId), {
    type: "tool_use",
    id: "child-send-user",
    name: "send_message",
    input: { to: "ankur", content: "status for Ankur" },
  });
  assert.equal(send.isError, false);

  const dispatch = await executeTool(runtime.toolContext(childId), {
    type: "tool_use",
    id: "child-dispatch-user",
    name: "send_message",
    input: { to: "ankur", content: "hello Ankur" },
  });
  assert.equal(dispatch.isError, false);

  const toParent = await executeTool(runtime.toolContext(childId), {
    type: "tool_use",
    id: "child-dispatch-parent",
    name: "send_message",
    input: { to: parentId, content: "blocked on login" },
  });
  assert.equal(toParent.isError, false);

  const rootSend = await executeTool(runtime.toolContext(parentId), {
    type: "tool_use",
    id: "root-send-user",
    name: "send_message",
    input: { to: "ankur", content: "report to Ankur" },
  });
  assert.equal(rootSend.isError, false);
  await runtime.waitUntilIdle();
});

test("an agent-to-agent message past the cap goes as its opening with the whole text attached; the same text to Ankur goes whole", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const senderId = await insertAgent(handle.db, { id: "cap-sender", systemPrompt: "sender" });
  const peerId = await insertAgent(handle.db, { id: "cap-peer", systemPrompt: "peer" });
  const nas = mockNas();
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas,
    config,
    log: silentLog,
  });
  const dump = "grep hit\n".repeat(AGENT_MESSAGE_MAX_CHARS / 9 + 1);

  const toPeer = await executeTool(runtime.toolContext(senderId), {
    type: "tool_use",
    id: "cap-dispatch-peer",
    name: "send_message",
    input: { to: peerId, content: dump },
  });
  assert.equal(toPeer.isError, false);
  assert.match(toPeer.content, /message\.md/);
  const stored = await handle.db.select().from(messages).where(eq(messages.toAgentId, peerId));
  assert.equal(stored.length, 1);
  assert.ok(stored[0]!.content.length < AGENT_MESSAGE_MAX_CHARS, "the recipient sees only the opening inline");
  const files = await handle.db.select().from(attachments).where(eq(attachments.messageId, stored[0]!.id));
  assert.equal(files.length, 1);
  assert.equal(nas.files.get(files[0]!.path!)?.toString(), dump, "the whole message travels as the attachment");

  const toAnkur = await executeTool(runtime.toolContext(senderId), {
    type: "tool_use",
    id: "cap-dispatch-ankur",
    name: "send_message",
    input: { to: "ankur", content: dump },
  });
  assert.equal(toAnkur.isError, false);
  await runtime.waitUntilIdle();
});

test("messaging a retired agent is a retired error on every path and stores nothing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const senderId = await insertAgent(handle.db, { id: "msg-sender", systemPrompt: "sender" });
  const retiredId = await insertAgent(handle.db, { id: "msg-retired", systemPrompt: "retired" });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, retiredId));
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas: mockNas(),
    runtime,
  });

  const posted = await app.inject({
    method: "POST",
    url: "/messages",
    payload: { to_agent_id: retiredId, content: "are you there?" },
  });
  assert.equal(posted.statusCode, 409);
  assert.equal((posted.json() as { error: { type: string } }).error.type, "retired");

  const send = await executeTool(runtime.toolContext(senderId), {
    type: "tool_use",
    id: "send-retired",
    name: "send_message",
    input: { to: retiredId, content: "ask it something" },
  });
  assert.equal(send.isError, true);
  assert.equal(send.content, `retired: agent ${retiredId} is retired`);

  const dispatch = await executeTool(runtime.toolContext(senderId), {
    type: "tool_use",
    id: "dispatch-retired",
    name: "send_message",
    input: { to: retiredId, content: "hello?" },
  });
  assert.equal(dispatch.isError, true);
  assert.equal(dispatch.content, `retired: agent ${retiredId} is retired`);

  const stored = await handle.db.select().from(messages).where(eq(messages.toAgentId, retiredId));
  assert.equal(stored.length, 0);
  await runtime.waitUntilIdle();
  await app.close();
});


test("POST /agents/:id/read marks a thread read across devices and /threads counts what is left", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { name: "reader", systemPrompt: "system" });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas: mockNas(),
    runtime,
  });
  const deps = {
    db: handle.db,
    transcript: runtime.transcript,
    events: runtime.events,
    answerByMinutes: 5,
    enqueue: runtime.enqueue,
    preempt: runtime.deliver.preempt,
  };
  await deliverUserMessage(deps, agentId, "ping");
  const first = await deliverAgentMessage(deps, { fromAgentId: agentId, toAgentId: null, content: "one" });
  const second = await deliverAgentMessage(deps, { fromAgentId: agentId, toAgentId: null, content: "two" });
  await insertMessage(handle.db, {
    fromAgentId: agentId,
    toAgentId: null,
    content: "run failed",
    attachments: NO_ATTACHMENTS,
    kind: "notice",
  });

  type Thread = { agent_id: string; unread: number; read_seq: number | null };
  const thread = async (): Promise<Thread | undefined> => {
    const res = await app.inject({ method: "GET", url: "/threads" });
    assert.equal(res.statusCode, 200);
    return (res.json() as { threads: Thread[] }).threads.find((t) => t.agent_id === agentId);
  };
  const before = await thread();
  assert.equal(before?.unread, 2);
  assert.equal(before?.read_seq, null);

  const seen: unknown[] = [];
  const unsubscribe = runtime.events.subscribe((event) => {
    if (event.type === "thread_read") seen.push(event);
  });
  const read = await app.inject({ method: "POST", url: `/agents/${agentId}/read`, payload: { seq: first.seq } });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), { agent_id: agentId, read_seq: first.seq, unread: 1 });
  assert.equal(seen.length, 1);
  assert.equal((await thread())?.unread, 1);

  const back = await app.inject({ method: "POST", url: `/agents/${agentId}/read`, payload: { seq: 1 } });
  assert.equal(back.statusCode, 200);
  assert.equal((back.json() as { read_seq: number }).read_seq, first.seq);

  const all = await app.inject({ method: "POST", url: `/agents/${agentId}/read`, payload: { seq: second.seq } });
  assert.deepEqual(all.json(), { agent_id: agentId, read_seq: second.seq, unread: 0 });
  assert.equal((await thread())?.read_seq, second.seq);

  const past = await app.inject({ method: "POST", url: `/agents/${agentId}/read`, payload: { seq: second.seq + 1000 } });
  assert.equal(past.statusCode, 422);
  const unknown = await app.inject({ method: "POST", url: "/agents/no-such-agent/read", payload: { seq: 1 } });
  assert.equal(unknown.statusCode, 404);

  unsubscribe();
  await app.close();
});
