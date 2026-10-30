import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { writeAgentLog } from "../src/db/logs.js";
import { agentLogs } from "../src/db/schema.js";
import { HathError } from "../src/errors.js";
import { deliverAgentMessage } from "../src/runtime/deliver.js";
import { createRuntime } from "../src/runtime/engine.js";
import { EventBus, type RuntimeEvent } from "../src/runtime/events.js";
import { executeTool } from "../src/runtime/tools.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { allTools } from "../src/tools/registry.js";
import { LIST_AGENTS, MESSAGE, SEND, YIELD } from "../src/types/domain.js";
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

test("EventBus.subscribe receives emitted events; unsubscribe stops delivery", () => {
  const bus = new EventBus(silentLog);
  const agentId = randomUUID();
  const seen: RuntimeEvent[] = [];
  const unsubscribe = bus.subscribe((event) => {
    seen.push(event);
  });
  bus.emit({
    type: "agent_modified",
    agent_id: agentId,
    name: "alpha",
    active: true,
    at: new Date().toISOString(),
  });
  assert.equal(seen.length, 1);
  unsubscribe();
  bus.emit({
    type: "agent_modified",
    agent_id: agentId,
    name: "alpha",
    active: false,
    at: new Date().toISOString(),
  });
  assert.equal(seen.length, 1);
});

test("a throwing listener is logged and does not block others or the emitter", () => {
  const errors: Array<{ obj: unknown; msg?: string }> = [];
  const bus = new EventBus({
    ...silentLog,
    error: (obj, msg) => {
      errors.push(msg === undefined ? { obj } : { obj, msg });
    },
  });
  const seen: RuntimeEvent[] = [];
  bus.subscribe(() => {
    throw new Error("subscriber blew up");
  });
  bus.subscribe((event) => {
    seen.push(event);
  });
  assert.doesNotThrow(() => {
    bus.emit({
      type: "lane_started",
      agent_id: randomUUID(),
      lane: "process",
      at: new Date().toISOString(),
    });
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.type, "lane_started");
  assert.deepEqual(errors, [
    {
      obj: { event: "lane_started", error: "subscriber blew up" },
      msg: "runtime event listener failed",
    },
  ]);
});

test("POST /messages emits a message event", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertAgent(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const seen: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    if (event.type === "message") {
      seen.push(event);
    }
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), nas: mockNas(),
    runtime,
  });
  const res = await app.inject({
    method: "POST",
    url: "/messages",
    payload: { to_agent_id: workerId, content: "hello events" },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(seen.length, 1);
  const event = seen[0];
  assert.ok(event && event.type === "message");
  assert.equal(event.agent_id, workerId);
  assert.equal(event.from_agent_id, null);
  assert.equal(event.to_agent_id, workerId);
  assert.equal(event.content, "hello events");
  await runtime.waitUntilIdle();
  await app.close();
});

test("GET /health includes started_at for live-transcript alignment", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas: mockNas(),
  });
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { status?: string; started_at?: string };
  assert.equal(body.status, "ok");
  assert.equal(typeof body.started_at, "string");
  assert.ok(body.started_at && !Number.isNaN(Date.parse(body.started_at)));
  await app.close();
});

test("send emits message with agent_id set to the recipient", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const callerId = await insertAgent(handle.db, {
    name: "dispatcher",
    systemPrompt: "dispatch",
  });
  const targetId = await insertAgent(handle.db, {
    name: "dispatch-target",
    systemPrompt: "target",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const seen: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    if (event.type === "message") {
      seen.push(event);
    }
  });
  const result = await executeTool(runtime.toolContext(callerId, "process"), {
    type: "tool_use",
    id: "d-evt",
    name: SEND,
    input: { to: targetId, content: "ping" },
  });
  assert.equal(result.isError, false);
  assert.equal(seen.length, 1);
  const event = seen[0];
  assert.ok(event && event.type === "message");
  assert.equal(event.agent_id, targetId);
  assert.equal(event.from_agent_id, callerId);
  assert.equal(event.to_agent_id, targetId);
  await runtime.waitUntilIdle();
});

test("deliverAgentMessage merges extraPayload into both message log rows", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const fromId = await insertAgent(handle.db, {
    name: "from",
    systemPrompt: "from",
  });
  const toId = await insertAgent(handle.db, {
    name: "deliver-extra-target",
    systemPrompt: "target",
  });
  const transcript = new TranscriptStore();
  const events = new EventBus(silentLog);
  const seen: RuntimeEvent[] = [];
  events.subscribe((event) => {
    if (event.type === "message") {
      seen.push(event);
    }
  });
  const enqueued: string[] = [];

  const beforeLen = transcript.transcriptFor(toId).length;
  await deliverAgentMessage(
    {
      db: handle.db,
      transcript,
      events,
      enqueueProcess: (agentId) => {
        enqueued.push(agentId);
     return "";
 },
      enqueueWork: () => "",
    },
    {
      fromAgentId: fromId,
      toAgentId: toId,
      content: "scheduled ping",
      extraPayload: { schedule_id: "x" },
    },
  );

  assert.equal(transcript.transcriptFor(toId).length, beforeLen + 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(enqueued, [toId]);

  const logs = await handle.db
    .select()
    .from(agentLogs)
    .where(and(eq(agentLogs.event, "message"), eq(agentLogs.lane, "process")));
  const messageLogs = logs.filter(
    (row) =>
      row.payload.schedule_id === "x" &&
      (row.agentId === fromId || row.agentId === toId),
  );
  assert.equal(messageLogs.length, 2);
  const directions = new Set(messageLogs.map((row) => row.payload.direction));
  assert.deepEqual(directions, new Set(["send", "receive"]));
});

test("lane_finished is emitted even when the lane run throws", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertAgent(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
  });
  const dwar = mockDwar({
    process: async () => {
      throw new Error("dwar exploded");
    },
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    yaad: mockYaad(),
    ghar: mockGhar(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const finished: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    if (event.type === "lane_finished" && event.lane === "process") {
      finished.push(event);
    }
  });
  runtime.enqueueProcess(workerId);
  await runtime.waitUntilIdle();
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.type, "lane_finished");
  if (finished[0]?.type === "lane_finished") {
    assert.equal(finished[0].agent_id, workerId);
    assert.equal(finished[0].lane, "process");
  }
});

test("GET /agents includes running and it flips true while a lane holds the lock", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertAgent(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), nas: mockNas(),
    runtime,
  });

  const idle = await app.inject({ method: "GET", url: "/agents" });
  assert.equal(idle.statusCode, 200);
  const idleBody = idle.json() as {
    agents: Array<{ id: string; running: { work: boolean; process: boolean } }>;
  };
  const idleAgent = idleBody.agents.find((agent) => agent.id === workerId);
  assert.ok(idleAgent);
  assert.deepEqual(idleAgent.running, { work: false, process: false, waiting_on: null });

  const release = await runtime.locks.acquire(workerId, "process", 1000);
  const held = await app.inject({ method: "GET", url: "/agents" });
  assert.equal(held.statusCode, 200);
  const heldBody = held.json() as {
    agents: Array<{ id: string; running: { work: boolean; process: boolean } }>;
  };
  const heldAgent = heldBody.agents.find((agent) => agent.id === workerId);
  assert.ok(heldAgent);
  assert.deepEqual(heldAgent.running, { work: false, process: true, waiting_on: null });
  release();

  await app.close();
});

test("GET /agents shows the helper tasks an agent owns, read from Nas, and steering one announces the change", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertAgent(handle.db, { name: "thread", systemPrompt: "do the job" });
  const nas = mockNas({});
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas,
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas,
    runtime,
  });
  const sessionsOf = async () =>
    (
      (await app.inject({ method: "GET", url: "/agents" })).json() as {
        agents: Array<{ id: string; sessions: { tasks: Array<{ id: string; kind: string; purpose: string }> } }>;
      }
    ).agents.find((agent) => agent.id === workerId)!.sessions;
  assert.deepEqual(await sessionsOf(), { tasks: [] });

  const changes: string[] = [];
  runtime.events.subscribe((event) => changes.push(event.type));
  const steered = await executeTool(runtime.toolContext(workerId, "work"), {
    type: "tool_use",
    id: "sb1",
    name: "steer_browser",
    input: { message: "open the portal" },
  });
  assert.equal(steered.isError, false, steered.content);
  assert.ok(changes.includes("sessions_changed"));
  const live = await sessionsOf();
  assert.equal(live.tasks.length, 1);
  assert.equal(live.tasks[0]?.id, "task/browser/1");
  assert.equal(live.tasks[0]?.kind, "browser");
  assert.equal(live.tasks[0]?.purpose, "open the portal");

  nas.tasks.clear();
  assert.deepEqual(await sessionsOf(), { tasks: [] }, "a task Nas forgot is gone at once");
  await app.close();
});

test("GET /agents lists multiple top-level workers without conflict", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const firstId = await insertAgent(handle.db, {
    name: "first",
    systemPrompt: "first job",
  });
  const secondId = await insertAgent(handle.db, {
    name: "second",
    systemPrompt: "second job",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), nas: mockNas(),
    runtime,
  });

  const res = await app.inject({ method: "GET", url: "/agents" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    agents: Array<{ id: string; parent_agent_id: string | null }>;
  };
  const ids = new Set(body.agents.map((agent) => agent.id));
  assert.ok(ids.has(firstId));
  assert.ok(ids.has(secondId));
  const listed = body.agents.filter((agent) => agent.id === firstId || agent.id === secondId);
  assert.equal(listed.length, 2);
  assert.ok(listed.every((agent) => agent.parent_agent_id === null));

  await app.close();
});

test("GET /agents/:id includes granted tools and excludes embedded tools", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertAgent(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), nas: mockNas(),
    runtime,
  });
  const res = await app.inject({ method: "GET", url: `/agents/${workerId}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    tools: Array<{ name: string; description: string }>;
    running: { work: boolean; process: boolean };
  };
  assert.ok(body.running);
  assert.ok(body.tools.length > 0);
  for (const tool of body.tools) {
    assert.ok(typeof tool.name === "string" && tool.name.length > 0);
    assert.ok(typeof tool.description === "string");
  }
  const names = body.tools.map((tool) => tool.name);
  assert.deepEqual(names, allTools().map((tool) => tool.name));
  assert.equal(names.includes(MESSAGE), false);
  assert.equal(names.includes(SEND), false);
  assert.equal(names.includes("steer_work"), false);
  assert.equal(names.includes(YIELD), false);
  assert.equal(names.includes(LIST_AGENTS), false);
  await app.close();
});

test("GET /logs returns across agents; event filters; limit above cap is 422", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertAgent(handle.db, {
    name: "log-worker",
    systemPrompt: "logs",
  });
  const otherId = await insertAgent(handle.db, {
    name: "log-other",
    systemPrompt: "other",
  });
  await writeAgentLog(handle.db, {
    agentId: workerId,
    lane: "process",
    event: "message",
    payload: { note: "from-worker" },
  });
  await writeAgentLog(handle.db, {
    agentId: otherId,
    lane: "work",
    event: "response",
    payload: { note: "from-other" },
  });
  await writeAgentLog(handle.db, {
    agentId: otherId,
    lane: "process",
    event: "message",
    payload: { note: "other-message" },
  });

  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), nas: mockNas(),
    runtime,
  });

  const all = await app.inject({ method: "GET", url: "/logs" });
  assert.equal(all.statusCode, 200);
  const allBody = all.json() as { logs: Array<{ agent_id: string; event: string }> };
  const agentIds = new Set(allBody.logs.map((log) => log.agent_id));
  assert.ok(agentIds.has(workerId));
  assert.ok(agentIds.has(otherId));

  const filtered = await app.inject({ method: "GET", url: "/logs?event=message" });
  assert.equal(filtered.statusCode, 200);
  const filteredBody = filtered.json() as { logs: Array<{ event: string }> };
  assert.ok(filteredBody.logs.length >= 2);
  assert.ok(filteredBody.logs.every((log) => log.event === "message"));

  const capped = await app.inject({ method: "GET", url: "/logs?limit=201" });
  assert.equal(capped.statusCode, 422);

  await app.close();
});
