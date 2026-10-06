import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { TZDate } from "@date-fns/tz";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { agentLogs, agents, scheduledMessages } from "../src/db/schema.js";
import { createRuntime } from "../src/runtime/engine.js";
import type { RuntimeEvent } from "../src/runtime/events.js";
import { advanceRunAt } from "../src/runtime/scheduler.js";
import { executeTool } from "../src/runtime/tools.js";
import { allTools, findEmbeddedTool, findTool } from "../src/tools/registry.js";
import {
  insertAgent,
  insertWorker,
  mockDwar,
  mockGhar,
  mockChaavi,
  mockNas,
  mockYaad,
  openTestDb,
  resetRuntime,
  testConfig,
} from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

type LogObj = Record<string, unknown>;

function capturingLog() {
  const warnings: LogObj[] = [];
  const errors: LogObj[] = [];
  return {
    warnings,
    errors,
    log: {
      info() {},
      warn(obj: unknown) {
        if (obj && typeof obj === "object") {
          warnings.push(obj as LogObj);
        }
      },
      error(obj: unknown) {
        if (obj && typeof obj === "object") {
          errors.push(obj as LogObj);
        }
      },
    },
  };
}

function wallTime(date: Date): string {
  const zoned = new TZDate(date.getTime(), config.env.timezone);
  const y = zoned.getFullYear();
  const m = String(zoned.getMonth() + 1).padStart(2, "0");
  const d = String(zoned.getDate()).padStart(2, "0");
  const h = String(zoned.getHours()).padStart(2, "0");
  const min = String(zoned.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}:${min}`;
}

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

test("the three schedule tools are embedded, not grantable", async () => {
  assert.equal(allTools().length, 52);
  for (const name of ["schedule_message", "list_schedules", "cancel_schedule"]) {
    assert.equal(findTool(name), undefined);
    assert.equal(findEmbeddedTool(name)?.name, name);
  }
});

test("due one-shot delivers once and deletes the row", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const fromId = await insertWorker(handle.db, {
    name: "scheduler",
    systemPrompt: "schedule work",
    tools: [],
  });
  const toId = await insertAgent(handle.db, {
    name: "one-shot-target",
    systemPrompt: "target",
  });
  const scheduleId = randomUUID();
  const runAt = new Date(Date.now() - 60_000);
  await handle.db.insert(scheduledMessages).values({
    id: scheduleId,
    fromAgentId: fromId,
    toAgentId: toId,
    content: "do it",
    runAt,
    intervalMinutes: null,
  });

  const { log } = capturingLog();
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log,
  });
  const seen: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    if (event.type === "message") {
      seen.push(event);
    }
  });

  await runtime.scheduler.tick();
  await runtime.waitUntilIdle();

  const transcript = runtime.transcript.transcriptFor(toId);
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0]?.fromAgentId, fromId);
  assert.equal(transcript[0]?.content, "do it");
  assert.equal(seen.length, 1);

  const logs = await handle.db
    .select()
    .from(agentLogs)
    .where(and(eq(agentLogs.event, "message"), eq(agentLogs.lane, "conversation")));
  const withSchedule = logs.filter((row) => row.payload.schedule_id === scheduleId);
  assert.equal(withSchedule.length, 2);

  const remaining = await handle.db
    .select()
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, scheduleId));
  assert.equal(remaining.length, 0);
});

test("not yet due leaves the row untouched", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const fromId = await insertWorker(handle.db, {
    name: "scheduler",
    systemPrompt: "schedule work",
    tools: [],
  });
  const toId = await insertAgent(handle.db, {
    name: "future-target",
    systemPrompt: "target",
  });
  const scheduleId = randomUUID();
  const runAt = new Date(Date.now() + 3600_000);
  await handle.db.insert(scheduledMessages).values({
    id: scheduleId,
    fromAgentId: fromId,
    toAgentId: toId,
    content: "later",
    runAt,
    intervalMinutes: 10,
  });

  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: capturingLog().log,
  });
  await runtime.scheduler.tick();
  await runtime.waitUntilIdle();

  assert.equal(runtime.transcript.transcriptFor(toId).length, 0);
  const [row] = await handle.db
    .select()
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, scheduleId));
  assert.ok(row);
  assert.equal(row.runAt.getTime(), runAt.getTime());
});

test("recurring sub-day advances run_at by exactly the interval", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const fromId = await insertWorker(handle.db, {
    name: "scheduler",
    systemPrompt: "schedule work",
    tools: [],
  });
  const toId = await insertAgent(handle.db, {
    name: "ten-min-target",
    systemPrompt: "target",
  });
  const scheduleId = randomUUID();
  const runAt = new Date("2026-06-01T12:00:00.000Z");
  await handle.db.insert(scheduledMessages).values({
    id: scheduleId,
    fromAgentId: fromId,
    toAgentId: toId,
    content: "tick",
    runAt,
    intervalMinutes: 10,
  });

  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: capturingLog().log,
  });
  await runtime.scheduler.tick(new Date("2026-06-01T12:00:30.000Z"));
  await runtime.waitUntilIdle();

  assert.equal(runtime.transcript.transcriptFor(toId).length, 1);
  const [row] = await handle.db
    .select()
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, scheduleId));
  assert.ok(row);
  assert.equal(row.runAt.toISOString(), "2026-06-01T12:10:00.000Z");
});

test("recurring daily preserves wall time across DST transitions", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const fromId = await insertWorker(handle.db, {
    name: "scheduler",
    systemPrompt: "schedule work",
    tools: [],
  });
  const toId = await insertAgent(handle.db, {
    name: "dst-target",
    systemPrompt: "target",
  });

  const fallId = randomUUID();
  const fallRunAt = new TZDate(2026, 9, 31, 17, 0, 0, 0, config.env.timezone);
  await handle.db.insert(scheduledMessages).values({
    id: fallId,
    fromAgentId: fromId,
    toAgentId: toId,
    content: "fall",
    runAt: new Date(fallRunAt.getTime()),
    intervalMinutes: 1440,
  });

  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: capturingLog().log,
  });
  await runtime.scheduler.tick(new Date(fallRunAt.getTime() + 1000));
  await runtime.waitUntilIdle();

  const [fallRow] = await handle.db
    .select()
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, fallId));
  assert.ok(fallRow);
  assert.equal(wallTime(fallRow.runAt), "2026-11-01T17:00");
  assert.equal(advanceRunAt(new Date(fallRunAt.getTime()), 1440).toISOString(), fallRow.runAt.toISOString());

  await handle.sql`TRUNCATE scheduled_messages CASCADE`;
  const springId = randomUUID();
  const springRunAt = new TZDate(2027, 2, 13, 17, 0, 0, 0, config.env.timezone);
  await handle.db.insert(scheduledMessages).values({
    id: springId,
    fromAgentId: fromId,
    toAgentId: toId,
    content: "spring",
    runAt: new Date(springRunAt.getTime()),
    intervalMinutes: 1440,
  });
  await runtime.scheduler.tick(new Date(springRunAt.getTime() + 1000));
  await runtime.waitUntilIdle();

  const [springRow] = await handle.db
    .select()
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, springId));
  assert.ok(springRow);
  assert.equal(wallTime(springRow.runAt), "2027-03-14T17:00");
});

test("catch-up delivers once, advances past now, and warns schedule_late", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const fromId = await insertWorker(handle.db, {
    name: "scheduler",
    systemPrompt: "schedule work",
    tools: [],
  });
  const toId = await insertAgent(handle.db, {
    name: "catchup-target",
    systemPrompt: "target",
  });
  const scheduleId = randomUUID();
  const runAt = new Date("2026-06-01T12:00:00.000Z");
  await handle.db.insert(scheduledMessages).values({
    id: scheduleId,
    fromAgentId: fromId,
    toAgentId: toId,
    content: "catch up",
    runAt,
    intervalMinutes: 10,
  });

  const { log, warnings } = capturingLog();
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log,
  });
  const now = new Date("2026-06-01T12:25:00.000Z");
  await runtime.scheduler.tick(now);
  await runtime.waitUntilIdle();

  assert.equal(runtime.transcript.transcriptFor(toId).length, 1);
  const [row] = await handle.db
    .select()
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, scheduleId));
  assert.ok(row);
  assert.equal(row.runAt.toISOString(), "2026-06-01T12:30:00.000Z");

  const late = warnings.find((entry) => entry.code === "schedule_late");
  assert.ok(late);
  assert.equal(late.schedule_id, scheduleId);
  assert.equal(late.skipped, 2);
  assert.equal(late.fired_at, runAt.toISOString());
});

test("retired target skips delivery and logs schedule_target_unavailable", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const fromId = await insertWorker(handle.db, {
    name: "scheduler",
    systemPrompt: "schedule work",
    tools: [],
  });
  const toId = await insertAgent(handle.db, {
    name: "retired-target",
    systemPrompt: "target",
  });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, toId));
  const scheduleId = randomUUID();
  const runAt = new Date(Date.now() - 1000);
  await handle.db.insert(scheduledMessages).values({
    id: scheduleId,
    fromAgentId: fromId,
    toAgentId: toId,
    content: "nope",
    runAt,
    intervalMinutes: 10,
  });

  const { log, errors } = capturingLog();
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log,
  });
  await runtime.scheduler.tick();
  await runtime.waitUntilIdle();

  assert.equal(runtime.transcript.transcriptFor(toId).length, 0);
  const messageLogs = await handle.db
    .select()
    .from(agentLogs)
    .where(eq(agentLogs.event, "message"));
  assert.equal(messageLogs.length, 0);

  const unavailable = errors.find((entry) => entry.code === "schedule_target_unavailable");
  assert.ok(unavailable);
  assert.equal(unavailable.reason, "retired");
  assert.equal(unavailable.schedule_id, scheduleId);

  const [row] = await handle.db
    .select()
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, scheduleId));
  assert.ok(row);
  assert.ok(row.runAt.getTime() > runAt.getTime());
});

test("missing target skips delivery with reason missing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const fromId = await insertWorker(handle.db, {
    name: "scheduler",
    systemPrompt: "schedule work",
    tools: [],
  });
  const toId = await insertAgent(handle.db, {
    name: "soon-missing",
    systemPrompt: "target",
  });
  const scheduleId = randomUUID();
  await handle.db.insert(scheduledMessages).values({
    id: scheduleId,
    fromAgentId: fromId,
    toAgentId: toId,
    content: "ghost",
    runAt: new Date(Date.now() - 1000),
    intervalMinutes: null,
  });

  await handle.sql`SET session_replication_role = 'replica'`;
  await handle.db.delete(agents).where(eq(agents.id, toId));
  await handle.sql`SET session_replication_role = 'origin'`;

  const { log, errors } = capturingLog();
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log,
  });
  await runtime.scheduler.tick();
  await runtime.waitUntilIdle();

  assert.equal(runtime.transcript.transcriptFor(toId).length, 0);
  const unavailable = errors.find((entry) => entry.code === "schedule_target_unavailable");
  assert.ok(unavailable);
  assert.equal(unavailable.reason, "missing");
  assert.equal(unavailable.to_agent_id, toId);
});

test("tick error is isolated and a later tick still runs", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const fromId = await insertWorker(handle.db, {
    name: "scheduler",
    systemPrompt: "schedule work",
    tools: [],
  });
  const toId = await insertAgent(handle.db, {
    name: "throw-target",
    systemPrompt: "target",
  });
  const firstId = randomUUID();
  await handle.db.insert(scheduledMessages).values({
    id: firstId,
    fromAgentId: fromId,
    toAgentId: toId,
    content: "boom",
    runAt: new Date(Date.now() - 2000),
    intervalMinutes: null,
  });

  const { log, errors } = capturingLog();
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log,
  });
  const original = runtime.transcript.ingest.bind(runtime.transcript);
  runtime.transcript.ingest = () => {
    throw new Error("forced delivery failure");
  };
  await runtime.scheduler.tick();
  assert.ok(errors.some((entry) => entry.code === "schedule_tick_failed"));
  runtime.transcript.ingest = original;

  const secondId = randomUUID();
  await handle.db.insert(scheduledMessages).values({
    id: secondId,
    fromAgentId: fromId,
    toAgentId: toId,
    content: "ok",
    runAt: new Date(Date.now() - 1000),
    intervalMinutes: null,
  });
  await runtime.scheduler.tick();
  await runtime.waitUntilIdle();
  assert.equal(runtime.transcript.transcriptFor(toId).length, 1);
  assert.equal(runtime.transcript.transcriptFor(toId)[0]?.content, "ok");
});

test("schedule_message validates self, missing, past, and interval; allows non-child", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const fromId = await insertWorker(handle.db, {
    name: "scheduler",
    systemPrompt: "schedule work",
    tools: [],
  });
  const peerId = await insertAgent(handle.db, {
    name: "peer-agent",
    systemPrompt: "peer",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: capturingLog().log,
  });
  const ctx = runtime.toolContext(fromId, "reasoning");
  const future = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "+00:00");

  const self = await executeTool(ctx, {
    type: "tool_use",
    id: "s-self",
    name: "schedule_message",
    input: {
      to_agent_id: fromId,
      content: "no",
      run_at: future,
    },
  });
  assert.equal(self.isError, true);
  assert.match(self.content, /cannot schedule a message to itself/);

  const missing = await executeTool(ctx, {
    type: "tool_use",
    id: "s-missing",
    name: "schedule_message",
    input: {
      to_agent_id: "missing-peer-agent",
      content: "no",
      run_at: future,
    },
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content, /not found/);

  const past = await executeTool(ctx, {
    type: "tool_use",
    id: "s-past",
    name: "schedule_message",
    input: {
      to_agent_id: peerId,
      content: "no",
      run_at: "2020-01-01T00:00:00+00:00",
    },
  });
  assert.equal(past.isError, true);
  assert.match(past.content, /run_at must be in the future/);

  const zero = await executeTool(ctx, {
    type: "tool_use",
    id: "s-zero",
    name: "schedule_message",
    input: {
      to_agent_id: peerId,
      content: "no",
      run_at: future,
      interval_minutes: 0,
    },
  });
  assert.equal(zero.isError, true);

  const ok = await executeTool(ctx, {
    type: "tool_use",
    id: "s-ok",
    name: "schedule_message",
    input: {
      to_agent_id: peerId,
      content: "hello peer",
      run_at: future,
      interval_minutes: 60,
    },
  });
  assert.equal(ok.isError, false);
  const body = JSON.parse(ok.content) as { schedule_id: string; to_agent_id: string };
  assert.equal(body.to_agent_id, peerId);
  const rows = await handle.db
    .select()
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, body.schedule_id));
  assert.equal(rows.length, 1);
});

test("cancel_schedule enforces creator; list_schedules is caller-scoped", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const creatorId = await insertWorker(handle.db, {
    name: "creator",
    systemPrompt: "creator",
    tools: [],
  });
  const otherId = await insertWorker(handle.db, {
    name: "other",
    systemPrompt: "other",
    tools: [],
  });
  const targetId = await insertAgent(handle.db, {
    name: "list-target",
    systemPrompt: "target",
  });
  const mine = randomUUID();
  const theirs = randomUUID();
  const runAt = new Date(Date.now() + 120_000);
  await handle.db.insert(scheduledMessages).values([
    {
      id: mine,
      fromAgentId: creatorId,
      toAgentId: targetId,
      content: "mine",
      runAt,
      intervalMinutes: null,
    },
    {
      id: theirs,
      fromAgentId: otherId,
      toAgentId: targetId,
      content: "theirs",
      runAt,
      intervalMinutes: null,
    },
  ]);

  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: capturingLog().log,
  });

  const listed = await executeTool(runtime.toolContext(creatorId, "reasoning"), {
    type: "tool_use",
    id: "list",
    name: "list_schedules",
    input: {},
  });
  assert.equal(listed.isError, false);
  const listBody = JSON.parse(listed.content) as {
    schedules: Array<{ id: string }>;
  };
  assert.deepEqual(
    listBody.schedules.map((row) => row.id),
    [mine],
  );

  const denied = await executeTool(runtime.toolContext(otherId, "reasoning"), {
    type: "tool_use",
    id: "cancel-deny",
    name: "cancel_schedule",
    input: { schedule_id: mine },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content, /only the creator/);

  const unknown = await executeTool(runtime.toolContext(creatorId, "reasoning"), {
    type: "tool_use",
    id: "cancel-unknown",
    name: "cancel_schedule",
    input: { schedule_id: randomUUID() },
  });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /not found/);

  const cancelled = await executeTool(runtime.toolContext(creatorId, "reasoning"), {
    type: "tool_use",
    id: "cancel-ok",
    name: "cancel_schedule",
    input: { schedule_id: mine },
  });
  assert.equal(cancelled.isError, false);
  const left = await handle.db
    .select()
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, mine));
  assert.equal(left.length, 0);
});

test("loadConfig exposes schedule.tick_seconds", () => {
  assert.equal(config.schedule.tick_seconds, 10);
});

test("schedule routes list an agent's schedules both ways, edit them, and cancel them", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const senderId = await insertAgent(handle.db, { name: "route-sender", systemPrompt: "sender" });
  const receiverId = await insertAgent(handle.db, { name: "route-receiver", systemPrompt: "receiver" });
  const outsiderId = await insertAgent(handle.db, { name: "route-outsider", systemPrompt: "outsider" });
  const sent = randomUUID();
  const unrelated = randomUUID();
  await handle.db.insert(scheduledMessages).values([
    {
      id: sent,
      fromAgentId: senderId,
      toAgentId: receiverId,
      content: "daily triage",
      runAt: new Date(Date.now() + 3_600_000),
      intervalMinutes: 1440,
    },
    {
      id: unrelated,
      fromAgentId: outsiderId,
      toAgentId: receiverId,
      content: "not the sender's",
      runAt: new Date(Date.now() + 7_200_000),
      intervalMinutes: null,
    },
  ]);
  const deps = {
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
  };
  const runtime = createRuntime({ ...deps, config, log: capturingLog().log });
  const app = await buildApp(config, { ...deps, sql: handle.sql, runtime });

  const senderList = await app.inject({ method: "GET", url: `/agents/${senderId}/schedules` });
  assert.equal(senderList.statusCode, 200, senderList.body);
  assert.deepEqual(
    (senderList.json() as { schedules: Array<{ id: string }> }).schedules.map((row) => row.id),
    [sent],
  );
  const receiverList = await app.inject({ method: "GET", url: `/agents/${receiverId}/schedules` });
  assert.deepEqual(
    (receiverList.json() as { schedules: Array<{ id: string }> }).schedules.map((row) => row.id),
    [sent, unrelated],
  );

  const runAt = new Date(Date.now() + 86_400_000);
  const edited = await app.inject({
    method: "PATCH",
    url: `/schedules/${sent}`,
    payload: { run_at: runAt.toISOString(), interval_minutes: null, content: "  weekly triage  " },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  const [row] = await handle.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, sent));
  assert.equal(row?.runAt.getTime(), runAt.getTime());
  assert.equal(row?.intervalMinutes, null);
  assert.equal(row?.content, "weekly triage");

  const past = await app.inject({
    method: "PATCH",
    url: `/schedules/${sent}`,
    payload: { run_at: new Date(Date.now() - 60_000).toISOString() },
  });
  assert.equal(past.statusCode, 422);
  assert.match(past.body, /run_at must be in the future/);
  const empty = await app.inject({ method: "PATCH", url: `/schedules/${sent}`, payload: {} });
  assert.equal(empty.statusCode, 422);

  const cancelled = await app.inject({ method: "DELETE", url: `/schedules/${sent}` });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal((await handle.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, sent))).length, 0);
  const again = await app.inject({ method: "DELETE", url: `/schedules/${sent}` });
  assert.equal(again.statusCode, 404);
  await app.close();
});
