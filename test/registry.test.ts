import assert from "node:assert/strict";
import { test } from "node:test";
import { toolsForLane } from "../src/runtime/context.js";
import { allTools, findEmbeddedTool, findTool } from "../src/tools/registry.js";

const REGISTRY = [
  "hath_spawn_agent",
  "ghar_list_devices",
  "ghar_get_state",
  "ghar_control_device",
  "ghar_get_device_events",
];

test("the registry is the house tools and spawn_agent, and nothing else", () => {
  assert.deepEqual(allTools().map((tool) => tool.name).sort(), [...REGISTRY].sort());
  for (const tool of allTools()) {
    assert.ok(tool.description.length > 0, tool.name);
  }
});

test("findTool returns undefined for a name not in the registry", () => {
  assert.equal(findTool("does_not_exist"), undefined);
});

test("removed tools are in neither the registry nor the embedded set", () => {
  for (const name of [
    "grant_tool",
    "revoke_tool",
    "list_tools",
    "nas_get_status",
    "nas_get_logs",
    "device_get_info",
    "chaavi_list_items",
    "yaad_search_history",
    "yaad_get_node_history",
  ]) {
    assert.equal(findTool(name), undefined, name);
    assert.equal(findEmbeddedTool(name), undefined, name);
  }
});

test("agent-management tools are embedded, not registry tools", () => {
  for (const name of ["get_agent", "get_logs"]) {
    assert.equal(findTool(name), undefined, name);
    assert.equal(findEmbeddedTool(name)?.name, name);
  }
});

test("every agent's work lane holds every registry tool, whatever its id", () => {
  for (const agentId of ["career-manager", "browser-worker-1", "anyone"]) {
    const held = new Set(toolsForLane(agentId, "work").map((tool) => tool.name));
    for (const name of REGISTRY) {
      assert.ok(held.has(name), `${agentId} lacks ${name}`);
    }
    assert.ok(held.has("get_agent"));
    assert.ok(held.has("steer_browser"));
  }
});

test("the process lane holds no registry tool", () => {
  const held = new Set(toolsForLane("anyone", "process").map((tool) => tool.name));
  for (const name of REGISTRY) {
    assert.equal(held.has(name), false, name);
  }
});
