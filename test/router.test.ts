import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { and, eq, isNull } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { agentLogs, agents, messages } from "../src/db/schema.js";
import { createRuntime } from "../src/runtime/engine.js";
import type { RuntimeEvent } from "../src/runtime/events.js";
import type { DwarChatResponse } from "../src/types/domain.js";
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

test("POST /router spawns a root, sends as Ankur, and returns what it sent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const dwar = scripted([
    toolUse("spawn_agent", { id: "escape-room-booking", system_prompt: "Own the escape room booking." }, "c1"),
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

  const delivered = runtime.transcript.transcriptFor("escape-room-booking");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.fromAgentId, null);
  assert.match(delivered[0]?.content ?? "", /book it/);

  const stored = await handle.db.select().from(messages).where(and(isNull(messages.fromAgentId), isNull(messages.toAgentId)));
  assert.deepEqual(stored.map((row) => [row.kind, row.content]), [["utterance", "can I afford the escape room tomorrow? if so book it"]]);

  const started = seen.find((event) => event.type === "router_started");
  const finished = seen.find((event) => event.type === "router_finished");
  assert.ok(started && finished);
  assert.equal(finished.run_id, started.run_id);
  assert.deepEqual((await app.inject({ method: "GET", url: "/router" })).json(), { running: [] });
  assert.equal(dwar.completeCalls.length, 3);

  await runtime.waitUntilIdle();
  await app.close();
});

test("POST /router composes system doctrine, charter, identity, and roots; offers router tools only", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "finance-specialist", systemPrompt: "Owns Ankur's money." });
  await insertAgent(handle.db, { id: "finance-worker-1", systemPrompt: "One job.", parentAgentId: "finance-specialist" });
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
  assert.match(system, /Agent directory: [^\n]*\n- finance-specialist\n {2}\(no description yet\) Owns Ankur's money\./);
  assert.doesNotMatch(system, /finance-worker/);
  assert.match(String(request.messages.at(-1)?.content), /^\[From: Ankur · \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]\nhi$/);

  const names = (request.tools ?? []).map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "forward_attachment",
    "get_agent",
    "get_logs",
    "get_messages",
    "list_agents",
    "read_file",
    "recall_memory",
    "send_message",
    "spawn_agent",
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

test("POST /router cannot modify agents", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "coding-manager", systemPrompt: "Owns terminals." });
  await insertAgent(handle.db, { id: "coding-worker", systemPrompt: "One job.", parentAgentId: "coding-manager" });
  const dwar = scripted([
    toolUse("manage_agent", { agent_id: "coding-manager", retired: true }, "m1"),
  ]);
  const { app, runtime } = await appWith(dwar);

  const res = await app.inject({ method: "POST", url: "/router", payload: { content: "x" } });
  assert.equal(res.statusCode, 201, res.body);
  const logs = await handle.db.select().from(agentLogs).where(isNull(agentLogs.agentId));
  const results = logs.filter((row) => row.event === "tool_result").map((row) => row.payload);
  const modify = results.find((payload) => payload.name === "manage_agent");
  assert.equal(modify?.is_error, true);
  assert.match(String(modify?.content), /unknown router tool/);

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
  assert.ok(events.includes("tool_result:send_message"), events.join(","));
  assert.ok(!events.some((entry) => entry.startsWith("message:")), events.join(","));
  const [utterance] = await handle.db.select().from(messages).where(eq(messages.kind, "utterance"));
  assert.equal(utterance?.content, "budget");
  const sent = logs.find((row) => row.event === "tool_result" && row.payload.name === "send_message");
  const [delivered] = await handle.db.select().from(messages).where(eq(messages.toAgentId, "finance-specialist"));
  assert.equal(sent?.payload.message_id, delivered?.id);
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

/** Poll until `condition` holds, so a test can wait on a request that is still in flight. */
async function waitFor(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("POST /router refuses a second run with 409 router_busy while one is in flight, and accepts one after it finishes", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const gates: Array<() => void> = [];
  const dwar = mockDwar({
    complete: () =>
      new Promise((resolve) => {
        gates.push(() => resolve(yieldTurn("held")));
      }),
  });
  const { app, runtime } = await appWith(dwar);
  const seen: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    seen.push(event);
  });

  try {
    const first = app.inject({ method: "POST", url: "/router", payload: { content: "one" } });
    await waitFor(() => gates.length === 1);
    const started = seen.flatMap((event) => (event.type === "router_started" ? [event] : []));
    assert.equal(started.length, 1);

    const refused = await app.inject({ method: "POST", url: "/router", payload: { content: "two" } });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.deepEqual(refused.json(), {
      error: { type: "router_busy", message: "Dadi is busy with another request", run_id: started[0]?.run_id, at: started[0]?.at },
    });
    const listed = (await app.inject({ method: "GET", url: "/router" })).json() as { running: Array<{ run_id: string; at: string }> };
    assert.deepEqual(listed.running, [{ run_id: started[0]?.run_id, at: started[0]?.at }]);
    assert.equal(gates.length, 1);

    gates[0]?.();
    assert.equal((await first).statusCode, 201);
    assert.deepEqual((await app.inject({ method: "GET", url: "/router" })).json(), { running: [] });

    const next = app.inject({ method: "POST", url: "/router", payload: { content: "three" } });
    await waitFor(() => gates.length === 2);
    gates[1]?.();
    assert.equal((await next).statusCode, 201);
    assert.equal(seen.filter((event) => event.type === "router_started").length, 2);
  } finally {
    for (const release of gates) {
      release();
    }
    await runtime.waitUntilIdle();
    await app.close();
  }
});

test("a failed router run releases the router so the next request is accepted", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  let failing = true;
  const dwar = mockDwar({
    complete: () => {
      if (failing) {
        throw new Error("dwar unreachable");
      }
      return Promise.resolve(yieldTurn("ok"));
    },
  });
  const { app, runtime } = await appWith(dwar);

  const failed = await app.inject({ method: "POST", url: "/router", payload: { content: "one" } });
  assert.ok(failed.statusCode >= 500, failed.body);
  failing = false;
  const next = await app.inject({ method: "POST", url: "/router", payload: { content: "two" } });
  assert.equal(next.statusCode, 201, next.body);

  await runtime.waitUntilIdle();
  await app.close();
});

test("a failed router run emits router_failed with its run id and leaves GET /router", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const dwar = mockDwar({
    complete: () => {
      throw new Error("dwar unreachable");
    },
  });
  const { app, runtime } = await appWith(dwar);
  const seen: RuntimeEvent[] = [];
  runtime.events.subscribe((event) => {
    seen.push(event);
  });

  const res = await app.inject({ method: "POST", url: "/router", payload: { content: "hi" } });
  assert.ok(res.statusCode >= 500, res.body);
  const started = seen.find((event) => event.type === "router_started");
  const failed = seen.find((event) => event.type === "router_failed");
  assert.ok(started && failed);
  assert.equal(failed.run_id, started.run_id);
  assert.match(failed.message, /dwar unreachable/);
  assert.deepEqual((await app.inject({ method: "GET", url: "/router" })).json(), { running: [] });

  await runtime.waitUntilIdle();
  await app.close();
});
