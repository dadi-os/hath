import assert from "node:assert/strict";
import { test } from "node:test";
import { runRecallMemory } from "../src/runtime/memory.js";
import type { ToolContext } from "../src/tools/shared.js";
import { mockYaad } from "./helpers.js";

const taskNode = {
  id: "0b6f4c2e-1d3a-4e5f-8a7b-9c0d1e2f3a4b",
  kind: "task" as const,
  title: "CSE 431 — HW5 Q5",
  body: "Submit on Gradescope.",
  occurred_at: null,
  expires_at: null,
  created_at: "2026-11-10T15:00:00.000Z",
  updated_at: "2026-11-11T15:00:00.000Z",
  detail: { opens_on: "2026-11-12", closes_at: "2026-11-26T04:59:00.000Z", done_at: null, verified_at: "2026-11-12T15:00:00.000Z" },
  hops: 0,
};

test("recall_memory sends relevant_on to Yaad and returns the tasks with their windows", async () => {
  const yaad = mockYaad({ recall: () => ({ nodes: [taskNode], edges: [], sufficient: null, coverage: null }) });
  const ctx = { yaad } as unknown as ToolContext;
  const result = await runRecallMemory(ctx, { relevant_on: "2026-11-20", kind: "task" });
  assert.equal(result.isError, false);
  assert.deepEqual(yaad.recallCalls, [{ relevant_on: "2026-11-20", kind: "task" }]);
  const nodes = JSON.parse(result.content).nodes;
  assert.equal(nodes[0].kind, "task");
  assert.deepEqual(nodes[0].detail, taskNode.detail);
  assert.equal(nodes[0].detail.verified_at, "2026-11-12T15:00:00.000Z");
  assert.equal(nodes[0].created_at, taskNode.created_at);
  assert.equal(nodes[0].updated_at, taskNode.updated_at);
});

test("recall_memory refuses the removed status filter and a bad date before calling it", async () => {
  const yaad = mockYaad();
  const ctx = { yaad } as unknown as ToolContext;
  await assert.rejects(() => runRecallMemory(ctx, { status: "confirmed" }));
  await assert.rejects(() => runRecallMemory(ctx, { relevant_on: "Nov 20" }));
  assert.equal(yaad.recallCalls.length, 0);
});
