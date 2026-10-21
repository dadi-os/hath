import assert from "node:assert/strict";
import { test } from "node:test";
import { HathError } from "../src/errors.js";
import type { ToolContext } from "../src/tools/shared.js";
import { findTool } from "../src/tools/registry.js";
import { mockYaad } from "./helpers.js";

const block = {
  start_at: "2026-10-21T07:00:00-04:00",
  end_at: "2026-10-21T07:30:00-04:00",
  title: "Wake up",
  kind: "wake",
  icon: "sun",
};

function ctxFor(yaad: ReturnType<typeof mockYaad>, caller: { kind: "agent" | "user"; id: string | null }): ToolContext {
  return { yaad, callerKind: caller.kind, callerId: caller.id } as unknown as ToolContext;
}

function tool(name: string) {
  const definition = findTool(name);
  assert.ok(definition, `${name} is registered`);
  return definition;
}

test("the planner tools are grantable and an agent's writes carry its id as the source", async () => {
  for (const name of ["planner_list_range", "planner_replace_range", "planner_add_block", "planner_update_block", "planner_delete_block"]) {
    assert.equal(findTool(name)?.name, name);
  }
  const yaad = mockYaad();
  const replace = tool("planner_replace_range");
  const parsed = replace.input.parse({ from: "2026-10-21T00:00:00-04:00", to: "2026-10-22T00:00:00-04:00", blocks: [block] });
  const result = await replace.handler(ctxFor(yaad, { kind: "agent", id: "schedule-specialist" }), parsed);
  assert.equal(result.isError, false);
  assert.deepEqual(yaad.plannerCalls[0], { op: "replace", body: { source: "schedule-specialist", ...parsed } });

  const add = tool("planner_add_block");
  await add.handler(ctxFor(yaad, { kind: "user", id: null }), add.input.parse(block));
  assert.equal((yaad.plannerCalls[1]?.body as { source: string }).source, "manual");
});

test("a block with an unknown icon or a non-ISO time is refused by the input schema", () => {
  const add = tool("planner_add_block");
  assert.equal(add.input.safeParse({ ...block, icon: "dumbbell" }).success, false);
  assert.equal(add.input.safeParse({ ...block, start_at: "tomorrow" }).success, false);
});

test("an overlap Yaad refuses reaches the agent as a tool error with the clashing pair", async () => {
  const yaad = mockYaad();
  yaad.plannerReplace = async () => {
    throw new HathError(409, "yaad", '"Call" (2026-10-21 09:30 to 10:30) overlaps "Class" (2026-10-21 09:00 to 10:00). Times are UTC.');
  };
  const replace = tool("planner_replace_range");
  const parsed = replace.input.parse({ from: "2026-10-21T00:00:00Z", to: "2026-10-22T00:00:00Z", blocks: [block] });
  const result = await replace.handler(ctxFor(yaad, { kind: "agent", id: "schedule-specialist" }), parsed);
  assert.equal(result.isError, true);
  assert.match(result.content, /"Call".*"Class"/);
});

test("update sends only the named fields and delete passes the id", async () => {
  const yaad = mockYaad();
  const update = tool("planner_update_block");
  const id = "11111111-1111-4111-8111-111111111111";
  await update.handler(ctxFor(yaad, { kind: "agent", id: "schedule-specialist" }), update.input.parse({ block_id: id, title: "Study" }));
  assert.deepEqual(yaad.plannerCalls[0], { op: "update", id, body: { title: "Study" } });
  const del = tool("planner_delete_block");
  await del.handler(ctxFor(yaad, { kind: "agent", id: "schedule-specialist" }), del.input.parse({ block_id: id }));
  assert.deepEqual(yaad.plannerCalls[1], { op: "delete", id });
});
