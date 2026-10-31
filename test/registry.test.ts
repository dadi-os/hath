import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { laneRegistryTool, toolsForLane } from "../src/runtime/lanes.js";
import { allTools, findTool } from "../src/tools/registry.js";

test("every tool has a description and a unique name", () => {
  const names = allTools().map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  for (const tool of allTools()) {
    assert.ok(tool.description.length > 0, tool.name);
  }
});

test("findTool returns undefined for a name not in the registry", () => {
  assert.equal(findTool("does_not_exist"), undefined);
});

test("removed tools are not in the registry", () => {
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
  }
});

test("every agent's work lane holds every registry tool, whatever its id", () => {
  for (const agentId of ["career-manager", "browser-worker-1", "anyone"]) {
    const held = new Set(toolsForLane(agentId, "work").map((tool) => tool.name));
    for (const tool of allTools()) {
      assert.ok(held.has(tool.name), `${agentId} lacks ${tool.name}`);
    }
  }
});

test("a worker's work lane has no ingest_memory and other agents' have it", () => {
  const holds = (agentId: string) => toolsForLane(agentId, "work").some((tool) => tool.name === "ingest_memory");
  assert.equal(holds("browser-worker-1"), false);
  assert.equal(holds("career-manager"), true);
});

test("the process and router lanes hold only the registry tools they name, and the router cannot find or search the web", () => {
  assert.equal(laneRegistryTool("process", "steer_browser"), undefined);
  assert.equal(laneRegistryTool("process", "web_search")?.name, "web_search");
  assert.equal(laneRegistryTool("router", "hath_spawn_agent")?.name, "hath_spawn_agent");
  assert.equal(laneRegistryTool("router", "find"), undefined);
  assert.equal(laneRegistryTool("router", "web_search"), undefined);
  assert.equal(laneRegistryTool("work", "web_search")?.name, "web_search");
});

/** The tool names `system.md` lists after `from`, up to `until` (or the line's end). */
function listedTools(line: string, from: string, until: string | null): Set<string> {
  const start = line.indexOf(from) + from.length;
  const end = until === null ? line.length : line.indexOf(until);
  return new Set([...line.slice(start, end).matchAll(/`([a-z_*]+)`/g)].map((match) => match[1]!));
}

test("system.md lists exactly the tools each agent lane holds", () => {
  const line = readFileSync(new URL("../prompts/system.md", import.meta.url), "utf8")
    .split("\n")
    .find((row) => row.startsWith("- Every agent holds the same tools"));
  assert.ok(line, "the tools line is missing from system.md");
  const expand = (names: Set<string>) =>
    [...names].flatMap((name) => (name.endsWith("*") ? allTools().map((tool) => tool.name).filter((n) => n.startsWith(name.slice(0, -1))) : [name]));
  const held = (lane: "work" | "process") => toolsForLane("anyone", lane).map((tool) => tool.name).sort();
  assert.deepEqual(expand(listedTools(line, "Your work lane holds", "Your process lane holds")).sort(), held("work"));
  assert.deepEqual(expand(listedTools(line, "Your process lane holds", null)).sort(), held("process"));
});
