import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { INGEST_MEMORY, LIST_AGENTS, RECALL_MEMORY, SEND_MESSAGE } from "../src/types/domain.js";
import { assembleContext } from "../src/runtime/context.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { migrate } from "../src/db/migrate.js";
import { allTools, findTool } from "../src/tools/registry.js";
import { syncTools } from "../src/tools/sync.js";
import { agentTools } from "../src/db/schema.js";
import { HathError } from "../src/errors.js";
import {
  endTurn,
  insertWorker,
  mockDwar,
  mockGhar,
  mockChaavi,
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

function runtimeWith(yaad: ReturnType<typeof mockYaad>, dwar = mockDwar({})) {
  return createRuntime({
    db: handle.db,
    dwar,
    yaad,
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
}

test("only the Yaad history tools stay grantable and syncTools does not auto-grant", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  assert.equal(findTool("yaad_get_node_history")?.name, "yaad_get_node_history");
  assert.equal(findTool("yaad_search_history")?.name, "yaad_search_history");
  for (const removed of ["yaad_recall", "yaad_query", "yaad_get_node", "yaad_ingest"]) {
    assert.equal(findTool(removed), undefined);
  }
  assert.equal(allTools().length, 52);
  await assert.doesNotReject(() => syncTools(handle.db));
  const grants = await handle.db.select().from(agentTools);
  assert.equal(grants.length, 0);
});

test("a reasoning lane with no grants still holds recall_memory and ingest_memory", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: [],
  });
  const ctx = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: workerId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
  });
  const names = new Set(ctx.tools.map((tool) => tool.name));
  for (const name of [RECALL_MEMORY, INGEST_MEMORY, SEND_MESSAGE, LIST_AGENTS, "yield"]) {
    assert.ok(names.has(name), `missing tool ${name}`);
  }
});

test("recall_memory passes anchors, hops, and filters through and shapes the response", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: [],
  });
  const nodeId = randomUUID();
  const neighborId = randomUUID();
  const yaad = mockYaad({
    recall: () => ({
      nodes: [
        {
          id: nodeId,
          kind: "person",
          title: "Oliver Chen",
          body: null,
          occurred_at: null,
          expires_at: null,
          detail: { birthday: null, aliases: [] },
          score: null,
          hops: 0,
        },
      ],
      edges: [
        {
          id: randomUUID(),
          src_id: nodeId,
          dst_id: neighborId,
          type: "WORKS_AT",
          properties: { role: "recruiter" },
        },
      ],
      sufficient: null,
      coverage: null,
      anchors: [nodeId],
      hops_taken: 1,
    }),
  });
  const result = await executeTool(runtimeWith(yaad).toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "r1",
    name: RECALL_MEMORY,
    input: { from: [nodeId], hops: 1 },
  });
  assert.equal(result.isError, false);
  assert.equal(yaad.recallCalls.length, 1);
  assert.deepEqual(yaad.recallCalls[0], { from: [nodeId], hops: 1 });
  const body = JSON.parse(result.content);
  assert.equal(body.nodes[0].id, nodeId);
  assert.equal(body.nodes[0].hops, 0);
  assert.equal(body.nodes[0].score, undefined);
  assert.equal(body.sufficient, null);
  assert.equal(body.anchors, undefined);
  assert.deepEqual(body.edges, [
    { src_id: nodeId, dst_id: neighborId, type: "WORKS_AT", properties: { role: "recruiter" } },
  ]);

  const filtered = await executeTool(runtimeWith(yaad).toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "r2",
    name: RECALL_MEMORY,
    input: {
      kind: "plan",
      occurred_from: "2026-09-21T00:00:00-04:00",
      occurred_to: "2026-09-27T23:59:59-04:00",
    },
  });
  assert.equal(filtered.isError, false);
  assert.equal(yaad.recallCalls[1]?.kind, "plan");
});

test("recall_memory rejects fields Yaad does not take", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: [],
  });
  const yaad = mockYaad();
  const result = await executeTool(runtimeWith(yaad).toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "r3",
    name: RECALL_MEMORY,
    input: { query: "anything", offset: 5 },
  });
  assert.equal(result.isError, true);
  assert.equal(yaad.recallCalls.length, 0);
});

test("ingest_memory stamps the calling agent, source, and occurred_at", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: [],
  });
  const before = Date.now();
  const yaad = mockYaad({
    ingest: () => ({
      counts: { create_node: 1, update_node: 0, close_node: 0, create_edge: 0, close_edge: 0, noop: 0 },
      operations: [{ op: "create_node", id: randomUUID() }],
      temp_ids: { p1: randomUUID() },
    }),
  });
  const runtime = runtimeWith(yaad);
  const result = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "i1",
    name: INGEST_MEMORY,
    input: { text: "Vedant likes orange juice" },
  });
  assert.equal(result.isError, false);
  assert.equal(yaad.ingestCalls.length, 1);
  const call = yaad.ingestCalls[0]!;
  assert.equal(call.source, "agent");
  assert.equal(call.agent_id, workerId);
  assert.equal(call.text, "Vedant likes orange juice");
  const stamped = Date.parse(call.occurred_at);
  assert.ok(stamped >= before - 1000);
  assert.ok(stamped <= Date.now() + 1000);
  const body = JSON.parse(result.content);
  assert.ok(body.counts);
  assert.ok(body.operations);
  assert.equal(body.temp_ids, undefined);

  const rejected = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "i2",
    name: INGEST_MEMORY,
    input: { text: "should fail", occurred_at: "2020-01-01T00:00:00.000Z" },
  });
  assert.equal(rejected.isError, true);
  assert.equal(yaad.ingestCalls.length, 1);
});

test("ingest_memory without an agent identity is an error and writes nothing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const yaad = mockYaad();
  const result = await executeTool(runtimeWith(yaad).toolContext(null, "reasoning"), {
    type: "tool_use",
    id: "i3",
    name: INGEST_MEMORY,
    input: { text: "no author" },
  });
  assert.equal(result.isError, true);
  assert.equal(yaad.ingestCalls.length, 0);
});

test("Yaad 4xx maps to isError without throwing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: [],
  });
  const yaad = mockYaad({
    recall: () => {
      throw new HathError(422, "yaad", "from cannot be combined with filters");
    },
  });
  const result = await executeTool(runtimeWith(yaad).toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "q2",
    name: RECALL_MEMORY,
    input: { from: [randomUUID()], kind: "plan" },
  });
  assert.equal(result.isError, true);
  assert.equal(result.content, "yaad: from cannot be combined with filters");
});

test("Yaad unreachable maps to isError and the lane continues", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: [],
  });
  let reasonCalls = 0;
  const dwar = mockDwar({
    reason: async () => {
      reasonCalls += 1;
      if (reasonCalls === 1) {
        return toolUse(RECALL_MEMORY, { query: "anything" }, "fail-call");
      }
      if (reasonCalls === 2) {
        return endTurn("recall failed; Yaad is unreachable, so I will stop here");
      }
      return yieldTurn("recovered");
    },
    converse: async () => yieldTurn(),
  });
  const yaad = mockYaad({
    recall: () => {
      throw new HathError(502, "upstream_unreachable", "Yaad is unreachable");
    },
  });
  const runtime = runtimeWith(yaad, dwar);
  runtime.enqueueReasoning(workerId);
  await runtime.waitUntilIdle();
  assert.equal(reasonCalls, 3, "lane continues after a failed tool call and after a text-only turn");
  assert.equal(yaad.recallCalls.length, 1);
});
