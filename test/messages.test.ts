import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { hydrateTranscript, listHumanMessages, listThreads } from "../src/db/messages.js";
import { agentLogs, agents, messages } from "../src/db/schema.js";
import { writeAgentLog } from "../src/db/logs.js";
import { arrivalsSince, assembleContext } from "../src/runtime/context.js";
import { deliverAgentMessage, deliverUserMessage } from "../src/runtime/deliver.js";
import { createRuntime } from "../src/runtime/engine.js";
import { EventBus } from "../src/runtime/events.js";
import { executeTool } from "../src/runtime/tools.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import {
  insertAgent,
  insertWorker,
  mockChaavi,
  mockDwar,
  mockGhar,
  mockNas,
  mockYaad,
  openTestDb,
  resetRuntime,
  roomyWakeLimits,
  silentLog,
  testConfig,
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
    enqueueConversation: () => {},
  };
}

test("deliverUserMessage persists messages row and log message_id", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertWorker(handle.db, {
    name: "persist-worker",
    systemPrompt: "you persist",
    tools: [],
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

test("assembleContext truncates to transcript_window_messages", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertWorker(handle.db, {
    name: "window-worker",
    systemPrompt: "system",
    tools: [],
  });
  const transcript = new TranscriptStore();
  const deps = deliverDeps(transcript);
  for (let i = 0; i < 5; i++) {
    await deliverUserMessage(deps, agentId, `user-${i}`);
    await deliverAgentMessage(deps, {
      fromAgentId: agentId,
      toAgentId: null,
      content: `agent-${i}`,
    });
  }

  const ctx = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId,
    lane: "conversation",
    transcript,
    transcriptWindowMessages: 4,
    transcriptWindowStep: 1,
  });
  assert.equal(ctx.messages.length, 4);
  assert.match(String(ctx.messages[0]?.content), /^\[From: Ankur · \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]\nuser-3$/);
  assert.match(String(ctx.messages[3]?.content), /^\[To: Ankur · \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]\nagent-4$/);
});

test("assembleContext advances the window in steps so the prefix survives new messages", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertWorker(handle.db, {
    name: "step-window-worker",
    systemPrompt: "system",
    tools: [],
  });
  const transcript = new TranscriptStore();
  const deps = deliverDeps(transcript);
  const assemble = () =>
    assembleContext({
      db: handle.db,
      serviceRoot: config.serviceRoot,
      agentId,
      lane: "reasoning",
      transcript,
      transcriptWindowMessages: 4,
      transcriptWindowStep: 3,
    });
  for (let i = 0; i < 10; i++) {
    await deliverUserMessage(deps, agentId, `m-${i}`);
  }

  const first = await assemble();
  assert.equal(first.messages.length, 4);
  await deliverUserMessage(deps, agentId, "m-10");
  const second = await assemble();
  assert.equal(second.messages.length, 5);
  assert.deepEqual(second.messages.slice(0, 4), first.messages);
  await deliverUserMessage(deps, agentId, "m-11");
  await deliverUserMessage(deps, agentId, "m-12");
  const third = await assemble();
  assert.equal(third.messages.length, 4);
  assert.match(String(third.messages[0]?.content), /^\[From: Ankur · \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]\nm-9$/);
  assert.equal(third.throughSeq, transcript.transcriptFor(agentId).at(-1)?.seq);
});

test("messages arriving mid-wake join the wake after it and never rewrite earlier turns", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertWorker(handle.db, {
    name: "arrival-worker",
    systemPrompt: "system",
    tools: [],
  });
  const transcript = new TranscriptStore();
  const deps = deliverDeps(transcript);
  await deliverUserMessage(deps, agentId, "find Oliver Chen");

  const { runReasoningLoop } = await import("../src/runtime/reasoning.js");
  const { SteerQueue } = await import("../src/runtime/steer.js");
  const { Wake } = await import("../src/runtime/wake.js");
  const requests: { messages: unknown[] }[] = [];
  let turn = 0;
  await runReasoningLoop({
    agentId,
    lane: "reasoning",
    wake: new Wake(roomyWakeLimits),
    assemble: () =>
      assembleContext({
        db: handle.db,
        serviceRoot: config.serviceRoot,
        agentId,
        lane: "reasoning",
        transcript,
        transcriptWindowMessages: 40,
        transcriptWindowStep: 20,
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
      const name = turn < 3 ? "wait" : "yield";
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
  assert.ok(last.content.indexOf("status?") < last.content.indexOf("on it"));
  assert.ok(first!.messages.every((m) => !JSON.stringify(m).includes("status?")));
});

test("hydrateTranscript restores durable rows into TranscriptStore", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertWorker(handle.db, {
    name: "hydrate-worker",
    systemPrompt: "system",
    tools: [],
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
  const agentId = await insertWorker(handle.db, {
    name: "api-worker",
    systemPrompt: "system",
    tools: [],
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
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
    chaavi: mockChaavi(),
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
      enqueueConversation: runtime.enqueueConversation,
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
  const a = await insertWorker(handle.db, {
    name: "alpha",
    systemPrompt: "a",
    tools: [],
  });
  const b = await insertWorker(handle.db, {
    name: "beta",
    systemPrompt: "b",
    tools: [],
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
  const a = await insertWorker(handle.db, {
    name: "alpha",
    systemPrompt: "a",
    tools: [],
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
  const agentId = await insertWorker(handle.db, {
    name: "backfill-worker",
    systemPrompt: "system",
    tools: [],
  });
  await writeAgentLog(handle.db, {
    agentId,
    lane: "conversation",
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
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "messages_party_check" CHECK ("from_agent_id" IS NOT NULL OR "to_agent_id" IS NOT NULL)
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
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: childId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
    transcriptWindowStep: 20,
  });
  assert.match(childCtx.system, /Your agent id is routing-child/);
  assert.match(childCtx.system, /Your parent is routing-parent/);

  const parentCtx = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: parentId,
    lane: "conversation",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
    transcriptWindowStep: 20,
  });
  assert.match(parentCtx.system, /Your agent id is routing-parent/);
  assert.match(parentCtx.system, /You are a root agent/);
});

test("child may still send_message and dispatch_message to the user", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, {
    id: "msg-parent",
    systemPrompt: "parent",
  });
  const childId = await insertWorker(handle.db, {
    id: "msg-child",
    systemPrompt: "child",
    parentAgentId: parentId,
    tools: [],
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  const send = await executeTool(runtime.toolContext(childId, "reasoning"), {
    type: "tool_use",
    id: "child-send-user",
    name: "send_message",
    input: { to_agent_id: null, intent: "status for Ankur" },
  });
  assert.equal(send.isError, false);

  const dispatch = await executeTool(runtime.toolContext(childId, "conversation"), {
    type: "tool_use",
    id: "child-dispatch-user",
    name: "dispatch_message",
    input: { to_agent_id: null, content: "hello Ankur" },
  });
  assert.equal(dispatch.isError, false);

  const toParent = await executeTool(runtime.toolContext(childId, "conversation"), {
    type: "tool_use",
    id: "child-dispatch-parent",
    name: "dispatch_message",
    input: { to_agent_id: parentId, content: "blocked on login" },
  });
  assert.equal(toParent.isError, false);

  const rootSend = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "root-send-user",
    name: "send_message",
    input: { to_agent_id: null, intent: "report to Ankur" },
  });
  assert.equal(rootSend.isError, false);
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
    chaavi: mockChaavi(),
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
    chaavi: mockChaavi(),
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

  const send = await executeTool(runtime.toolContext(senderId, "reasoning"), {
    type: "tool_use",
    id: "send-retired",
    name: "send_message",
    input: { to_agent_id: retiredId, intent: "ask it something" },
  });
  assert.equal(send.isError, true);
  assert.equal(send.content, `retired: agent ${retiredId} is retired`);

  const dispatch = await executeTool(runtime.toolContext(senderId, "conversation"), {
    type: "tool_use",
    id: "dispatch-retired",
    name: "dispatch_message",
    input: { to_agent_id: retiredId, content: "hello?" },
  });
  assert.equal(dispatch.isError, true);
  assert.equal(dispatch.content, `retired: agent ${retiredId} is retired`);

  const stored = await handle.db.select().from(messages).where(eq(messages.toAgentId, retiredId));
  assert.equal(stored.length, 0);
  await runtime.waitUntilIdle();
  await app.close();
});
