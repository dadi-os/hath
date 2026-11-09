import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { writeAgentLog } from "../src/db/logs.js";
import { insertMessage, insertUtterance, NO_ATTACHMENTS, stampMessageWake } from "../src/db/messages.js";
import { migrate } from "../src/db/migrate.js";
import { agentLogs, watches } from "../src/db/schema.js";
import { insertWake } from "../src/db/wakes.js";
import { HathError } from "../src/errors.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { WAKE_RESULT_MAX_CHARS } from "../src/serialize.js";
import type { NasClient } from "../src/nas/client.js";
import type { WakeEntry, WakeRecord } from "../src/types/domain.js";
import { insertAgent, mockDwar, mockGhar, mockNas, mockYaad, openTestDb, resetRuntime, silentLog, testConfig } from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
  await resetRuntime(handle.sql, handle.db, config);
});

after(async () => {
  await handle.close();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 8));
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function appWith(nas: NasClient = mockNas()) {
  const runtime = createRuntime({ db: handle.db, dwar: mockDwar({}), yaad: mockYaad(), ghar: mockGhar(), nas, config, log: silentLog });
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({}), yaad: mockYaad(), ghar: mockGhar(), nas, runtime });
  return { app, runtime };
}

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: 10,
  cache_read_input_tokens: 100,
});

test("GET /agents/:id/wakes pages newest first by keyset and derives outcome, usage and counts", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "wake-lister", systemPrompt: "lists" });
  await insertAgent(handle.db, { id: "wake-sender", systemPrompt: "sends" });
  const opener = await insertMessage(handle.db, { fromAgentId: "wake-sender", toAgentId: agentId, content: "do the thing", attachments: NO_ATTACHMENTS });
  const [oldest, middle, newest] = [randomUUID(), randomUUID(), randomUUID()];
  await insertWake(handle.db, {
    id: oldest,
    agentId,
    origin: { kind: "message", ref: "wake-sender", openedByMessageId: opener.id! },
    startedAt: minutesAgo(30),
    endedAt: minutesAgo(25),
  });
  await insertWake(handle.db, { id: middle, agentId, origin: { kind: "schedule", ref: randomUUID(), openedByMessageId: null }, startedAt: minutesAgo(20), endedAt: minutesAgo(15), error: "work lane stopped" });
  await insertWake(handle.db, { id: newest, agentId, origin: { kind: "manual", ref: null, openedByMessageId: null }, startedAt: minutesAgo(5) });
  await stampMessageWake(handle.db, opener.id!, oldest);
  for (const out of [10, 20]) {
    await writeAgentLog(handle.db, { agentId, lane: "work", event: "response", payload: { content: [], usage: usage(1, out) }, wakeId: oldest });
  }
  await writeAgentLog(handle.db, { agentId, lane: "work", event: "tool_result", payload: { tool_use_id: "t", name: "read_file", content: "x", is_error: false }, wakeId: oldest });
  await writeAgentLog(handle.db, { agentId, lane: "work", event: "response", payload: { content: [], usage: usage(1, 1) }, wakeId: middle });

  const { app } = await appWith();
  try {
    const first = await app.inject({ method: "GET", url: `/agents/${agentId}/wakes?limit=2` });
    assert.equal(first.statusCode, 200, first.body);
    const page = first.json() as { wakes: WakeRecord[]; next_before: { started_at: string; id: string } | null };
    assert.deepEqual(page.wakes.map((wake) => [wake.id, wake.outcome]), [[newest, "running"], [middle, "failed"]]);
    assert.deepEqual(page.next_before, { started_at: page.wakes[1]!.started_at, id: middle });
    assert.equal(page.wakes[1]!.error, "work lane stopped");
    assert.equal(page.wakes[1]!.activity_trimmed, false);

    const second = await app.inject({
      method: "GET",
      url: `/agents/${agentId}/wakes?limit=2&before_started_at=${encodeURIComponent(page.next_before!.started_at)}&before_id=${page.next_before!.id}`,
    });
    const rest = second.json() as { wakes: WakeRecord[]; next_before: unknown };
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(rest.next_before, null);
    const [wake] = rest.wakes;
    assert.equal(wake!.id, oldest);
    assert.equal(wake!.outcome, "yielded");
    assert.deepEqual(wake!.reason, { kind: "message", ref: "wake-sender" });
    assert.deepEqual(wake!.usage, { calls: 2, input_tokens: 2, output_tokens: 30, cache_write: 20, cache_read: 200 });
    assert.deepEqual(wake!.counts, { tool_calls: 1, messages_sent: 0, messages_received: 1 });
    assert.equal(wake!.opened_by?.seq, opener.seq);
    assert.deepEqual(wake!.opened_by?.attachments, []);
    assert.equal(wake!.activity_trimmed, false);
  } finally {
    await app.close();
  }
});

test("a wake that ended while the work lane watched something is waiting", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "wake-watcher", systemPrompt: "waits" });
  const wakeId = randomUUID();
  await insertWake(handle.db, { id: wakeId, agentId, origin: { kind: "manual", ref: null, openedByMessageId: null }, startedAt: minutesAgo(10), endedAt: minutesAgo(5) });
  await handle.db.insert(watches).values({ agentId, targets: ["task/browser/1"], since: minutesAgo(7), dueAt: minutesAgo(-30) });
  const { app } = await appWith();
  try {
    const res = await app.inject({ method: "GET", url: `/agents/${agentId}/wakes` });
    assert.equal((res.json() as { wakes: WakeRecord[] }).wakes[0]!.outcome, "waiting");
  } finally {
    await app.close();
  }
});

test("a wake with no activity rows, older than every row the agent still has, reports activity_trimmed", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "wake-trimmed", systemPrompt: "trimmed" });
  const wakeId = randomUUID();
  await insertWake(handle.db, { id: wakeId, agentId, origin: { kind: "manual", ref: null, openedByMessageId: null }, startedAt: minutesAgo(60), endedAt: minutesAgo(55) });
  await writeAgentLog(handle.db, { agentId, lane: "work", event: "response", payload: { content: [], usage: usage(1, 1) }, wakeId: randomUUID() });
  const { app } = await appWith();
  try {
    const res = await app.inject({ method: "GET", url: `/agents/${agentId}/wakes` });
    const [wake] = (res.json() as { wakes: WakeRecord[] }).wakes;
    assert.equal(wake!.activity_trimmed, true);
    assert.equal(wake!.usage.calls, 0);
  } finally {
    await app.close();
  }
});

test("wake list requests are validated with stable error codes", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "wake-validator", systemPrompt: "validates" });
  const { app } = await appWith();
  try {
    const type = async (url: string, status: number) => {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, status, `${url}: ${res.body}`);
      return (res.json() as { error: { type: string } }).error.type;
    };
    assert.equal(await type(`/agents/${agentId}/wakes?limit=101`, 422), "invalid_request");
    assert.equal(await type(`/agents/${agentId}/wakes?before_id=${randomUUID()}`, 422), "invalid_request");
    assert.equal(await type(`/agents/${agentId}/wakes?before_started_at=2026-11-08T10:00:00Z`, 422), "invalid_request");
    assert.equal(await type(`/agents/${agentId}/logs?wakes=3`, 422), "invalid_request");
    assert.equal(await type(`/agents/no-such-agent/wakes`, 404), "not_found");
    assert.equal(await type(`/agents/${agentId}/wakes/${randomUUID()}`, 404), "wake_not_found");
    assert.equal(await type(`/agents/${agentId}/wakes/not-a-uuid`, 422), "invalid_request");
  } finally {
    await app.close();
  }
});

test("GET /agents/:id/wakes/:wake_id merges messages and turns in order, pairing calls with results and cutting large ones", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "wake-detail", systemPrompt: "detail" });
  await insertAgent(handle.db, { id: "wake-peer", systemPrompt: "peer" });
  const wakeId = randomUUID();
  await insertWake(handle.db, { id: wakeId, agentId, origin: { kind: "message", ref: "wake-peer", openedByMessageId: null }, startedAt: minutesAgo(1) });
  await tick();
  const received = await insertMessage(handle.db, { fromAgentId: "wake-peer", toAgentId: agentId, content: "please look", attachments: NO_ATTACHMENTS });
  await stampMessageWake(handle.db, received.id!, wakeId);
  await tick();
  await writeAgentLog(handle.db, {
    agentId,
    lane: "process",
    event: "response",
    payload: {
      content: [
        { type: "thinking", thinking: "reading" },
        { type: "tool_use", id: "big", name: "read_file", input: { path: "/big" } },
        { type: "tool_use", id: "pending", name: "web_fetch", input: { url: "https://x" } },
      ],
      usage: usage(3, 4),
    },
    wakeId,
  });
  await tick();
  await writeAgentLog(handle.db, {
    agentId,
    lane: "process",
    event: "tool_result",
    payload: { tool_use_id: "big", name: "read_file", content: "y".repeat(WAKE_RESULT_MAX_CHARS + 5), is_error: false },
    wakeId,
  });
  await tick();
  const sent = await insertMessage(handle.db, { fromAgentId: agentId, toAgentId: "wake-peer", content: "found it", attachments: NO_ATTACHMENTS });
  await tick();
  const unrelated = await insertMessage(handle.db, { fromAgentId: "wake-peer", toAgentId: "wake-peer", content: "elsewhere", attachments: NO_ATTACHMENTS });

  const { app } = await appWith();
  try {
    const res = await app.inject({ method: "GET", url: `/agents/${agentId}/wakes/${wakeId}` });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { wake: WakeRecord; entries: WakeEntry[] };
    assert.equal(body.wake.id, wakeId);
    assert.equal(body.wake.outcome, "running");
    assert.deepEqual(body.wake.counts, { tool_calls: 1, messages_sent: 0, messages_received: 1 });
    assert.deepEqual(body.entries.map((entry) => entry.ord), [0, 1, 2]);
    const [first, turn, last] = body.entries;
    assert.deepEqual([first!.type, first!.type === "message" && first!.direction, first!.type === "message" && first!.message.seq], ["message", "received", received.seq]);
    if (turn === undefined || turn.type !== "turn") {
      throw new Error("expected a turn");
    }
    assert.equal(turn.lane, "process");
    assert.equal(turn.thinking, "reading");
    assert.equal(turn.text, null);
    const [big, pending] = turn.calls;
    assert.equal(big!.result?.truncated, true);
    assert.equal(big!.result?.chars, WAKE_RESULT_MAX_CHARS + 5);
    assert.equal(big!.result?.content.length, WAKE_RESULT_MAX_CHARS);
    assert.deepEqual([pending!.log_id, pending!.result], [null, null]);
    assert.equal(last!.type === "message" && last!.direction, "sent");
    assert.equal(last!.type === "message" && last!.message.seq, sent.seq);
    assert.ok(!body.entries.some((entry) => entry.type === "message" && entry.message.seq === unrelated.seq));

    const logRow = (await handle.db.select().from(agentLogs).where(eq(agentLogs.event, "tool_result")))[0]!;
    assert.equal(big!.log_id, logRow.id);
  } finally {
    await app.close();
  }
});

test("a wake of another agent is a 404 wake_not_found", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const owner = await insertAgent(handle.db, { id: "wake-owner", systemPrompt: "owns" });
  const other = await insertAgent(handle.db, { id: "wake-other", systemPrompt: "other" });
  const wakeId = randomUUID();
  await insertWake(handle.db, { id: wakeId, agentId: owner, origin: { kind: "manual", ref: null, openedByMessageId: null } });
  const { app } = await appWith();
  try {
    const res = await app.inject({ method: "GET", url: `/agents/${other}/wakes/${wakeId}` });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { error: { type: string } }).error.type, "wake_not_found");
  } finally {
    await app.close();
  }
});

test("GET /agents/:id/logs/:log_id returns the raw row, and 404 log_not_found for another agent's", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const owner = await insertAgent(handle.db, { id: "log-owner", systemPrompt: "owns" });
  const other = await insertAgent(handle.db, { id: "log-other", systemPrompt: "other" });
  await writeAgentLog(handle.db, { agentId: owner, lane: "work", event: "tool_result", payload: { tool_use_id: "t", name: "read_file", content: "whole", is_error: false } });
  const [row] = await handle.db.select().from(agentLogs).where(eq(agentLogs.agentId, owner));
  const { app } = await appWith();
  try {
    const found = await app.inject({ method: "GET", url: `/agents/${owner}/logs/${row!.id}` });
    assert.equal(found.statusCode, 200, found.body);
    const { log } = found.json() as { log: { id: string; event: string; payload: { content: string } } };
    assert.deepEqual([log.id, log.event, log.payload.content], [row!.id, "tool_result", "whole"]);
    const missing = await app.inject({ method: "GET", url: `/agents/${other}/logs/${row!.id}` });
    assert.equal(missing.statusCode, 404);
    assert.equal((missing.json() as { error: { type: string } }).error.type, "log_not_found");
  } finally {
    await app.close();
  }
});

test("POST /agents/:id/sessions/:task_id/halt halts an owned task and refuses another agent's", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "halt-owner", systemPrompt: "owns" });
  const nas = mockNas();
  const mine = await nas.startTask("browser", { agent_id: agentId, message: "fill the form" });
  const theirs = await nas.startTask("terminal", { agent_id: "someone-else", message: "build" });
  const { app } = await appWith(nas);
  try {
    const halted = await app.inject({ method: "POST", url: `/agents/${agentId}/sessions/${encodeURIComponent(mine.task)}/halt` });
    assert.equal(halted.statusCode, 200, halted.body);
    const { task } = halted.json() as { task: { id: string; status: string; purpose: string } };
    assert.deepEqual([task.id, task.status, task.purpose], [mine.task, "stopped", "fill the form"]);
    assert.deepEqual(nas.haltTaskCalls, [{ kind: "browser", id: mine.id }]);

    const foreign = await app.inject({ method: "POST", url: `/agents/${agentId}/sessions/${encodeURIComponent(theirs.task)}/halt` });
    assert.equal(foreign.statusCode, 404);
    assert.equal((foreign.json() as { error: { type: string } }).error.type, "task_not_found");
    assert.equal(nas.haltTaskCalls.length, 1);

    const malformed = await app.inject({ method: "POST", url: `/agents/${agentId}/sessions/${encodeURIComponent("task/browser")}/halt` });
    assert.equal(malformed.statusCode, 422);
  } finally {
    await app.close();
  }
});

test("a halt Nas refuses maps to stable codes: 404 task_not_found, 409 task_conflict, 5xx stays nas", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "halt-errors", systemPrompt: "owns" });
  const base = mockNas();
  const started = await base.startTask("browser", { agent_id: agentId, message: "work" });
  const refusing = (error: HathError): NasClient => ({ ...base, haltTask: async () => { throw error; } });
  const cases: Array<[HathError, number, string]> = [
    [new HathError(404, "not_found", "gone"), 404, "task_not_found"],
    [new HathError(409, "conflict", "busy"), 409, "task_conflict"],
    [new HathError(502, "nas", "Nas failed: boom"), 502, "nas"],
  ];
  for (const [error, status, type] of cases) {
    const { app } = await appWith(refusing(error));
    try {
      const res = await app.inject({ method: "POST", url: `/agents/${agentId}/sessions/${encodeURIComponent(started.task)}/halt` });
      assert.equal(res.statusCode, status, res.body);
      assert.equal((res.json() as { error: { type: string } }).error.type, type);
    } finally {
      await app.close();
    }
  }
});

test("get_messages reads a conversation newest first, searches text, pages, and keeps utterances for the router", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const me = await insertAgent(handle.db, { id: "msg-reader", systemPrompt: "reads" });
  const child = await insertAgent(handle.db, { id: "msg-child", systemPrompt: "child", parentAgentId: me });
  await insertAgent(handle.db, { id: "msg-peer", systemPrompt: "peer" });
  const say = async (from: string | null, to: string | null, content: string) => {
    await insertMessage(handle.db, { fromAgentId: from, toAgentId: to, content, attachments: NO_ATTACHMENTS });
    await tick();
  };
  await say("msg-peer", me, "the batch list is ready");
  await say(me, "msg-peer", "thanks, sending the batch");
  await say(null, me, "ankur here");
  await say(me, null, "reply to ankur");
  await say(child, me, "child report");
  await insertUtterance(handle.db, "router heard this");

  const { runtime } = await appWith();
  const read = async (callerId: string | null, lane: "work" | "router", input: Record<string, unknown>) => {
    const result = await executeTool(runtime.toolContext(callerId, lane), { type: "tool_use", id: "gm", name: "get_messages", input });
    return { isError: result.isError, body: result.isError ? result.content : (JSON.parse(result.content) as { messages: Array<{ content: string; seq: number; content_chars: number }>; next_before: string | null }) };
  };

  const all = await read(me, "work", {});
  assert.ok(typeof all.body !== "string");
  assert.deepEqual(all.body.messages.map((m) => m.content), ["child report", "reply to ankur", "ankur here", "thanks, sending the batch", "the batch list is ready"]);
  assert.equal(all.body.next_before, null);

  const peer = await read(me, "work", { with: "msg-peer" });
  assert.deepEqual(typeof peer.body !== "string" && peer.body.messages.map((m) => m.content), ["thanks, sending the batch", "the batch list is ready"]);

  const ankur = await read(me, "work", { with: "ankur" });
  assert.deepEqual(typeof ankur.body !== "string" && ankur.body.messages.map((m) => m.content), ["reply to ankur", "ankur here"]);

  const found = await read(me, "work", { search: "BATCH" });
  assert.equal(typeof found.body !== "string" && found.body.messages.length, 2);

  const paged = await read(me, "work", { limit: 2 });
  assert.ok(typeof paged.body !== "string" && paged.body.next_before !== null);
  const older = await read(me, "work", { limit: 2, before: (paged.body as { next_before: string }).next_before });
  assert.deepEqual(typeof older.body !== "string" && older.body.messages.map((m) => m.content), ["ankur here", "thanks, sending the batch"]);

  const ofChild = await read(me, "work", { agent_id: child });
  assert.equal(typeof ofChild.body !== "string" && ofChild.body.messages.length, 1);
  assert.equal((await read(child, "work", { agent_id: me })).isError, true);

  assert.equal((await read(me, "work", { include_utterances: true })).isError, true);
  assert.equal((await read(null, "router", {})).isError, true);
  const router = await read(null, "router", { agent_id: me, include_utterances: true });
  assert.ok(typeof router.body !== "string");
  assert.ok(router.body.messages.some((m) => m.content === "router heard this"));
  const plain = await read(null, "router", { agent_id: me });
  assert.ok(typeof plain.body !== "string" && !plain.body.messages.some((m) => m.content === "router heard this"));
});
