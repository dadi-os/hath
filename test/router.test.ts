import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { and, eq, isNull } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { agentLogs, agents, agentTools, messages } from "../src/db/schema.js";
import { createRuntime } from "../src/runtime/engine.js";
import type { RuntimeEvent } from "../src/runtime/events.js";
import { toolId } from "../src/tools/sync.js";
import type { DwarChatResponse } from "../src/types/domain.js";
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
  silentLog,
  testConfig,
  toolUse,
  yieldTurn,
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

/** Build an isolated Fastify app plus runtime against the shared test db. */
async function appWith(dwar = mockDwar({})) {
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
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    runtime,
  });
  return { app, runtime, dwar };
}

/** A mock Dwar whose `complete` plays back `turns` in order, then yields. */
function scripted(turns: DwarChatResponse[]) {
  let next = 0;
  return mockDwar({
    complete: () => turns[next++] ?? yieldTurn(`yield-${next}`),
  });
}

type RoutedBody = {
  messages: Array<{ to_agent_id: string; content: string; seq: number; created_at: string }>;
};

test("POST /router spawns a root, grants it, sends as Ankur, and returns what it sent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const dwar = scripted([
    toolUse("hath_spawn_agent", { id: "escape-room-booking", system_prompt: "Own the escape room booking." }, "c1"),
    toolUse(
      "grant_tool",
      {
        agent_id: "escape-room-booking",
        tools: [{ tool_name: "yaad_search_history", usage: "look up past plans" }],
      },
      "c2",
    ),
    toolUse("send_message", { to_agent_id: "escape-room-booking", content: "Check I can afford the escape room tomorrow, then book it." }, "c3"),
  ]);
  const { app, runtime } = await appWith(dwar);
  const seen: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    seen.push(event);
  });

  const res = await app.inject({
    method: "POST",
    url: "/router",
    payload: { content: "can I afford the escape room tomorrow? if so book it" },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as RoutedBody;
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0]?.to_agent_id, "escape-room-booking");

  const [agent] = await handle.db.select().from(agents).where(eq(agents.id, "escape-room-booking"));
  assert.equal(agent?.parentAgentId, null);
  const grants = await handle.db.select().from(agentTools).where(eq(agentTools.agentId, "escape-room-booking"));
  assert.deepEqual(grants.map((g) => g.toolId), [toolId("yaad_search_history")]);

  const delivered = runtime.transcript.transcriptFor("escape-room-booking");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.fromAgentId, null);
  assert.match(delivered[0]?.content ?? "", /book it/);

  const stored = await handle.db.select().from(messages).where(and(isNull(messages.fromAgentId), isNull(messages.toAgentId)));
  assert.equal(stored.length, 0);

  assert.ok(seen.some((event) => event.type === "router_started"));
  assert.ok(seen.some((event) => event.type === "router_finished"));
  assert.equal(dwar.completeCalls.length, 4);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /router composes system doctrine, charter, identity, and roots; offers router tools only", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "finance-specialist", systemPrompt: "Owns Ankur's money." });
  await insertAgent(handle.db, { id: "finance-worker", systemPrompt: "One job.", parentAgentId: "finance-specialist" });
  const dwar = scripted([]);
  const { app, runtime } = await appWith(dwar);

  const res = await app.inject({ method: "POST", url: "/router", payload: { content: "hi" } });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual((res.json() as RoutedBody).messages, []);

  const request = dwar.completeCalls[0]!;
  const system = request.system;
  const doctrine = readFileSync(join(config.serviceRoot, "prompts/system.md"), "utf8").trim();
  const charter = readFileSync(join(config.serviceRoot, "prompts/router.md"), "utf8").trim();
  assert.ok(system.startsWith(`${doctrine}\n\n${charter}\n\n`));
  assert.match(system, /- finance-specialist: Owns Ankur's money\./);
  assert.doesNotMatch(system, /finance-worker/);
  assert.match(String(request.messages.at(-1)?.content), /^\[From: Ankur · \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]\nhi$/);

  const names = (request.tools ?? []).map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "get_agent",
    "get_logs",
    "grant_tool",
    "hath_spawn_agent",
    "list_agents",
    "list_tools",
    "recall_memory",
    "revoke_tool",
    "send_message",
    "yield",
  ]);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /router sending to a retired agent is a retired error and revives nothing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "finance-specialist", systemPrompt: "Owns money." });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, "finance-specialist"));
  const dwar = scripted([
    toolUse("send_message", { to_agent_id: "finance-specialist", content: "How much tax did I pay last year?" }),
  ]);
  const { app, runtime } = await appWith(dwar);

  const res = await app.inject({ method: "POST", url: "/router", payload: { content: "taxes last year?" } });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual((res.json() as RoutedBody).messages, []);
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, "finance-specialist"));
  assert.equal(row?.active, false);
  const logs = await handle.db.select().from(agentLogs).where(isNull(agentLogs.agentId));
  const send = logs.find((log) => log.event === "tool_result" && log.payload.name === "send_message");
  assert.equal(send?.payload.is_error, true);
  assert.match(String(send?.payload.content), /^retired: agent finance-specialist is retired$/);
  const stored = await handle.db.select().from(messages).where(eq(messages.toAgentId, "finance-specialist"));
  assert.equal(stored.length, 0);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /router grants only to roots and cannot modify agents", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "coding-manager", systemPrompt: "Owns terminals." });
  await insertAgent(handle.db, { id: "coding-worker", systemPrompt: "One job.", parentAgentId: "coding-manager" });
  const dwar = scripted([
    toolUse(
      "grant_tool",
      { agent_id: "coding-worker", tools: [{ tool_name: "yaad_search_history", usage: "x" }] },
      "g1",
    ),
    toolUse("manage_agent", { agent_id: "coding-manager", retired: true }, "m1"),
  ]);
  const { app, runtime } = await appWith(dwar);

  const res = await app.inject({ method: "POST", url: "/router", payload: { content: "x" } });
  assert.equal(res.statusCode, 201, res.body);
  const logs = await handle.db.select().from(agentLogs).where(isNull(agentLogs.agentId));
  const results = logs.filter((row) => row.event === "tool_result").map((row) => row.payload);
  const grant = results.find((payload) => payload.name === "grant_tool");
  const modify = results.find((payload) => payload.name === "manage_agent");
  assert.equal(grant?.is_error, true);
  assert.match(String(grant?.content), /direct children/);
  assert.equal(modify?.is_error, true);
  assert.match(String(modify?.content), /unknown router tool/);
  const grants = await handle.db.select().from(agentTools).where(eq(agentTools.agentId, "coding-worker"));
  assert.equal(grants.length, 0);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /router logs its turns on the router lane with a null agent_id", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "finance-specialist", systemPrompt: "Owns money." });
  const dwar = scripted([
    toolUse("send_message", { to_agent_id: "finance-specialist", content: "Budget please." }),
  ]);
  const { app, runtime } = await appWith(dwar);

  const res = await app.inject({ method: "POST", url: "/router", payload: { content: "budget" } });
  assert.equal(res.statusCode, 201, res.body);
  const logs = await handle.db.select().from(agentLogs).where(isNull(agentLogs.agentId));
  assert.ok(logs.every((row) => row.lane === "router"));
  const events = logs.map((row) => `${row.event}:${String(row.payload.direction ?? row.payload.name ?? "")}`);
  assert.ok(events.includes("message:receive"), events.join(","));
  assert.ok(events.includes("message:send"), events.join(","));
  assert.ok(events.includes("tool_result:send_message"), events.join(","));
  assert.equal(logs.filter((row) => row.event === "response").length, 2);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /router runs as long as the model keeps calling tools", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "finance-specialist", systemPrompt: "Owns money." });
  const turns = Array.from({ length: 12 }, (_, i) =>
    toolUse("get_agent", { agent_id: "finance-specialist" }, `look-${i}`),
  );
  const dwar = scripted(turns);
  const { app, runtime } = await appWith(dwar);

  const res = await app.inject({ method: "POST", url: "/router", payload: { content: "look around" } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(dwar.completeCalls.length, 13);
  const assistantTurns = dwar.completeCalls.at(-1)!.messages.filter((m) => m.role === "assistant");
  assert.equal(assistantTurns.length, 12);
  for (const turn of assistantTurns) {
    assert.equal(turn.lane, undefined);
    assert.equal(turn.provider, undefined);
  }

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /router is ephemeral: each run sees only its own utterance", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "finance-specialist", systemPrompt: "Owns money." });
  const dwar = scripted([
    toolUse("send_message", { to_agent_id: "finance-specialist", content: "Build me a budget." }),
  ]);
  const { app, runtime } = await appWith(dwar);

  await app.inject({ method: "POST", url: "/router", payload: { content: "build me a budget" } });
  await app.inject({
    method: "POST",
    url: "/messages",
    payload: { to_agent_id: "finance-specialist", content: "typed straight into the thread" },
  });
  await app.inject({ method: "POST", url: "/router", payload: { content: "no, a monthly one" } });
  const second = dwar.completeCalls.at(-1)!;
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0]?.role, "user");
  assert.match(
    String(second.messages[0]?.content),
    /^\[From: Ankur · \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]\nno, a monthly one$/,
  );

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /router get_logs must name an agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "finance-specialist", systemPrompt: "Owns money." });
  const dwar = scripted([
    toolUse("get_logs", {}, "own"),
    toolUse("get_logs", { agent_id: "finance-specialist" }, "agent"),
  ]);
  const { app, runtime } = await appWith(dwar);

  const res = await app.inject({ method: "POST", url: "/router", payload: { content: "what's going on" } });
  assert.equal(res.statusCode, 201, res.body);
  const results = (await handle.db.select().from(agentLogs).where(isNull(agentLogs.agentId)))
    .filter((row) => row.event === "tool_result")
    .map((row) => row.payload);
  const own = results.find((payload) => payload.tool_use_id === "own");
  const agent = results.find((payload) => payload.tool_use_id === "agent");
  assert.equal(own?.is_error, true);
  assert.match(String(own?.content), /ephemeral/);
  assert.equal(agent?.is_error, false);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute rejects the retired dadi and user identities", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const { app, runtime } = await appWith();

  for (const retired of ["dadi", "user"]) {
    const res = await app.inject({
      method: "POST",
      url: "/tools/yaad_search_history/execute",
      payload: { as_agent_id: retired, query: "anything" },
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: { type: string } };
    assert.equal(body.error.type, "not_found");
  }

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute with as_agent_id runs a worker tool", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["yaad_search_history"],
  });
  const yaad = mockYaad({
    recall: () => ({
      nodes: [],
      edges: [],
      sufficient: false,
      coverage: 0,
    }),
  });
  const dwar = mockDwar({});
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    yaad,
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
    yaad,
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    runtime,
  });

  const res = await app.inject({
    method: "POST",
    url: "/tools/yaad_search_history/execute",
    payload: { as_agent_id: workerId, query: "Vedant lunch" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; is_error: boolean; content: string };
  assert.equal(body.ok, true);
  assert.equal(body.is_error, false);
  assert.deepEqual(yaad.searchHistoryCalls, [{ query: "Vedant lunch" }]);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute as router spawn_agent creates a root", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const { app, runtime } = await appWith();

  const res = await app.inject({
    method: "POST",
    url: "/tools/hath_spawn_agent/execute",
    payload: {
      as_agent_id: "router",
      id: "finance-specialist",
      system_prompt: "own the money",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; is_error: boolean; content: string };
  assert.equal(body.ok, true);
  assert.equal(body.is_error, false);
  const content = JSON.parse(body.content) as { agent_id: string };
  assert.equal(content.agent_id, "finance-specialist");

  const [agent] = await handle.db.select().from(agents).where(eq(agents.id, content.agent_id));
  assert.ok(agent);
  assert.equal(agent.parentAgentId, null);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute as router rejects worker tools", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const { app, runtime } = await appWith();

  const res = await app.inject({
    method: "POST",
    url: "/tools/yaad_search_history/execute",
    payload: { as_agent_id: "router", query: "anything" },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "invalid_request");
  assert.match(body.error.message, /router authority/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute without as_agent_id runs as the user without a grant", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const yaad = mockYaad({
    recall: () => ({
      nodes: [],
      edges: [],
      sufficient: false,
      coverage: 0,
    }),
  });
  const dwar = mockDwar({});
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    yaad,
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
    yaad,
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    runtime,
  });

  const res = await app.inject({
    method: "POST",
    url: "/tools/yaad_search_history/execute",
    payload: { query: "Vedant lunch" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; is_error: boolean; content: string };
  assert.equal(body.ok, true);
  assert.equal(body.is_error, false);
  assert.deepEqual(yaad.searchHistoryCalls, [{ query: "Vedant lunch" }]);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute with a missing agent id is 404", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const { app, runtime } = await appWith();
  const missing = "missing-agent-that-does-not-exist";

  const res = await app.inject({
    method: "POST",
    url: "/tools/yaad_search_history/execute",
    payload: { as_agent_id: missing, query: "anything" },
  });
  assert.equal(res.statusCode, 404);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "not_found");
  assert.match(body.error.message, /not found/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute without grant is 403", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "ungranted",
    systemPrompt: "no tools",
    tools: [],
  });
  const { app, runtime } = await appWith();

  const res = await app.inject({
    method: "POST",
    url: "/tools/yaad_search_history/execute",
    payload: { as_agent_id: workerId, query: "anything" },
  });
  assert.equal(res.statusCode, 403);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "forbidden");
  assert.match(body.error.message, /does not hold yaad_search_history/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /tools/:name/execute as a retired agent is 409 retired", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "retired",
    systemPrompt: "retired",
    tools: ["yaad_search_history"],
  });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, workerId));
  const { app, runtime } = await appWith();

  const res = await app.inject({
    method: "POST",
    url: "/tools/yaad_search_history/execute",
    payload: { as_agent_id: workerId, query: "anything" },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json() as { error: { type: string; message: string } };
  assert.equal(body.error.type, "retired");
  assert.match(body.error.message, /retired/);

  await runtime.waitUntilIdle();
  await app.close();
});

test("GET /agents/:id rejects non-kebab ids", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const { app, runtime } = await appWith();

  const res = await app.inject({ method: "GET", url: "/agents/Not-Valid" });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { error: { type: string } };
  assert.equal(body.error.type, "invalid_request");

  await runtime.waitUntilIdle();
  await app.close();
});
