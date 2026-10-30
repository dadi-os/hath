import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { hydrateTranscript, insertMessage, listHumanMessages, listThreads, NO_ATTACHMENTS } from "../src/db/messages.js";
import { agentLogs, agents, attachments, messages } from "../src/db/schema.js";
import { writeAgentLog } from "../src/db/logs.js";
import { arrivalsSince, assembleContext, type TranscriptWindow, windowStart } from "../src/runtime/context.js";
import { deliverAgentMessage, deliverUserMessage } from "../src/runtime/deliver.js";
import { createRuntime } from "../src/runtime/engine.js";
import { EventBus } from "../src/runtime/events.js";
import { executeTool } from "../src/runtime/tools.js";
import { AGENT_MESSAGE_MAX_CHARS } from "../src/tools/shared.js";
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
  wideWindows,
  workLoopHooks,
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
    enqueueProcess: () => "",
    enqueueWork: () => "",
  };
}

test("deliverUserMessage persists messages row and log message_id", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, {
    name: "persist-worker",
    systemPrompt: "you persist",
  });
  const transcript = new TranscriptStore();
  const row = await deliverUserMessage(deliverDeps(transcript), agentId, "hello durable");

  assert.ok(row.id);
  assert.ok(row.seq > 0);
  const stored = await handle.db.select().from(messages).where(eq(messages.id, row.id!));
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.content, "hello durable");
  assert.equal(stored[0]?.fromAgentId, null);
  assert.equal(stored[0]?.toAgentId, agentId);

  const logs = await handle.db
    .select()
    .from(agentLogs)
    .where(and(eq(agentLogs.agentId, agentId), eq(agentLogs.event, "message")));
  assert.equal(logs.length, 1);
  const payload = logs[0]?.payload as { message_id: string | null };
  assert.equal(payload.message_id, row.id);
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

test("assembleContext cuts each lane its own rolling window of the thread", async () => {
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
  const assemble = (processWindow: TranscriptWindow) =>
    assembleContext({
      db: handle.db,
      serviceRoot: config.serviceRoot,
      agentId,
      lane: "process",
      transcript,
      windows: { process: processWindow, work: wideWindows.work },
    });

  const whole = await assemble(wideWindows.process);
  const thread = whole.transcripts.work!;
  assert.equal(thread.length, 6);
  assert.equal(whole.transcripts.process!.length, 6, "no job note follows the thread on either lane");

  const narrow = await assemble({ chars: 500, stepChars: 200, budgetTokens: 10_000_000 });
  const sizes = thread.map((m) => String(m.content).length);
  const start = windowStart(sizes, { chars: 500, stepChars: 200 });
  assert.ok(start > 0);
  assert.deepEqual(narrow.transcripts.process, thread.slice(start));
  assert.match(String(narrow.transcripts.process!.at(-2)?.content), /\nm-5 /);
  assert.deepEqual(narrow.transcripts.work!.slice(0, -1), thread);
  assert.equal(narrow.throughSeq, whole.throughSeq);
});

test("assembleContext shortens a lane's window to the room its token budget leaves after the system and tools", async () => {
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
      lane: "process",
      transcript,
      windows: { process: { ...wideWindows.process, budgetTokens }, work: wideWindows.work },
    });

  const whole = await assemble(wideWindows.process.budgetTokens);
  const thread = whole.transcripts.work!.slice(0, -1);
  assert.equal(thread.length, 6);
  const fixedTokens =
    Math.ceil(whole.system.length / PROSE_CHARS_PER_TOKEN) +
    Math.ceil(JSON.stringify(whole.tools).length / DATA_CHARS_PER_TOKEN);

  const full = await assemble(fixedTokens);
  assert.deepEqual(full.transcripts.process!.slice(0, -1), thread.slice(-1));
  assert.deepEqual(full.transcripts.work!.slice(0, -1), thread);
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

  const { runWorkLoop } = await import("../src/runtime/work.js");
  const { SteerQueue } = await import("../src/runtime/steer.js");
  const { Wake } = await import("../src/runtime/wake.js");
  const requests: { messages: unknown[] }[] = [];
  let turn = 0;
  await runWorkLoop({
    ...workLoopHooks,
    agentId,
    lane: "work",
    wake: new Wake(roomyWakeLimits),
    assemble: () =>
      assembleContext({
        windows: wideWindows,
        db: handle.db,
        serviceRoot: config.serviceRoot,
        agentId,
        lane: "work",
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
      const name = turn < 3 ? "ghar_get_state" : "yield";
      return {
        provider: "anthropic" as const,
        content: [{ type: "tool_use" as const, id: `c${turn}`, name, input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    },
    executeTool: async () => ({ content: "{}", isError: false, audit: {} }),
    steer: new SteerQueue(),
    logResponse: async () => {},
    logToolResult: async () => {},
  });

  assert.equal(requests.length, 3);
  const [first, second, third] = requests as { messages: { role: string; content: unknown }[] }[];
  assert.deepEqual(second!.messages.slice(0, first!.messages.length), first!.messages);
  assert.deepEqual(third!.messages.slice(0, second!.messages.length), second!.messages);
  const last = second!.messages.at(-1)!;
  assert.equal(last.role, "user");
  assert.ok(typeof last.content === "string");
  assert.ok(last.content.includes("status?"));
  assert.ok(!last.content.includes("on it"), "the agent's own send is already in the wake, so it is no arrival");
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
      enqueueProcess: runtime.enqueueProcess,
      enqueueWork: runtime.enqueueWork,
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

test("backfill migration smoke: agent_logs message events land in messages after recreate", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, {
    name: "backfill-worker",
    systemPrompt: "system",
  });
  await writeAgentLog(handle.db, {
    agentId,
    lane: "process",
    event: "message",
    payload: {
      direction: "receive",
      message_id: null,
      from_agent_id: null,
      to_agent_id: agentId,
      content: "legacy from logs",
      seq: 1,
    },
  });

  await handle.sql`DROP TABLE IF EXISTS messages CASCADE`;
  await handle.sql`
    CREATE TABLE "messages" (
      "id" uuid PRIMARY KEY NOT NULL,
      "seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
      "from_agent_id" text,
      "to_agent_id" text,
      "content" text NOT NULL,
      "status" text,
      "kind" text DEFAULT 'message' NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "messages_party_check" CHECK ("from_agent_id" IS NOT NULL OR "to_agent_id" IS NOT NULL),
      CONSTRAINT "messages_status_check" CHECK ("status" IS NULL OR "status" IN ('running', 'needs_input', 'blocked', 'done'))
    )
  `;
  await handle.sql`
    ALTER TABLE "messages" ADD CONSTRAINT "messages_from_agent_id_agents_id_fk"
      FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade
  `;
  await handle.sql`
    ALTER TABLE "messages" ADD CONSTRAINT "messages_to_agent_id_agents_id_fk"
      FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade
  `;
  await handle.sql`
    ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk"
      FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade
  `;
  await handle.sql`
    INSERT INTO "messages" ("id", "from_agent_id", "to_agent_id", "content", "created_at")
    SELECT
      gen_random_uuid(),
      CASE
        WHEN payload->>'from_agent_id' IS NULL OR payload->>'from_agent_id' = '' THEN NULL
        ELSE payload->>'from_agent_id'
      END,
      CASE
        WHEN payload->>'to_agent_id' IS NULL OR payload->>'to_agent_id' = '' THEN NULL
        ELSE payload->>'to_agent_id'
      END,
      payload->>'content',
      "created_at"
    FROM "agent_logs"
    WHERE "event" = 'message'
      AND coalesce(payload->>'content', '') <> ''
      AND (
        (payload->>'from_agent_id' IS NULL OR payload->>'from_agent_id' = '')
        <> (payload->>'to_agent_id' IS NULL OR payload->>'to_agent_id' = '')
      )
    ORDER BY "created_at" ASC, "id" ASC
  `;

  const rows = await handle.db.select().from(messages);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.content, "legacy from logs");
  assert.equal(rows[0]?.toAgentId, agentId);
  assert.equal(rows[0]?.fromAgentId, null);

  await handle.sql`ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_party_check"`;
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
    windows: wideWindows,
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: childId,
    lane: "work",
    transcript: new TranscriptStore(),
  });
  assert.match(childCtx.system, /Your agent id is routing-child/);
  assert.match(childCtx.system, /Your parent is routing-parent/);

  const parentCtx = await assembleContext({
    windows: wideWindows,
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: parentId,
    lane: "process",
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

  const send = await executeTool(runtime.toolContext(childId, "work"), {
    type: "tool_use",
    id: "child-send-user",
    name: "message",
    input: { to: "ankur", content: "status for Ankur" },
  });
  assert.equal(send.isError, false);

  const dispatch = await executeTool(runtime.toolContext(childId, "process"), {
    type: "tool_use",
    id: "child-dispatch-user",
    name: "send",
    input: { to: "ankur", content: "hello Ankur" },
  });
  assert.equal(dispatch.isError, false);

  const toParent = await executeTool(runtime.toolContext(childId, "process"), {
    type: "tool_use",
    id: "child-dispatch-parent",
    name: "send",
    input: { to: parentId, content: "blocked on login" },
  });
  assert.equal(toParent.isError, false);

  const rootSend = await executeTool(runtime.toolContext(parentId, "work"), {
    type: "tool_use",
    id: "root-send-user",
    name: "message",
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

  const toPeer = await executeTool(runtime.toolContext(senderId, "process"), {
    type: "tool_use",
    id: "cap-dispatch-peer",
    name: "send",
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

  const toAnkur = await executeTool(runtime.toolContext(senderId, "process"), {
    type: "tool_use",
    id: "cap-dispatch-ankur",
    name: "send",
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

  const send = await executeTool(runtime.toolContext(senderId, "work"), {
    type: "tool_use",
    id: "send-retired",
    name: "message",
    input: { to: retiredId, content: "ask it something" },
  });
  assert.equal(send.isError, true);
  assert.equal(send.content, `retired: agent ${retiredId} is retired`);

  const dispatch = await executeTool(runtime.toolContext(senderId, "process"), {
    type: "tool_use",
    id: "dispatch-retired",
    name: "send",
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
    enqueueProcess: runtime.enqueueProcess,
    enqueueWork: runtime.enqueueWork,
  };
  await deliverUserMessage(deps, agentId, "ping");
  const first = await deliverAgentMessage(deps, { fromAgentId: agentId, toAgentId: null, content: "one" });
  const second = await deliverAgentMessage(deps, { fromAgentId: agentId, toAgentId: null, content: "two" });
  await insertMessage(handle.db, {
    fromAgentId: agentId,
    toAgentId: null,
    content: "lane failed",
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
