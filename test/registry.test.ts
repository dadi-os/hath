import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { agentRegistryTool, agentTools, routerRegistryTool, routerTools } from "../src/runtime/tool-set.js";
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

test("every agent holds every registry tool, whatever its id", () => {
  for (const agentId of ["career-manager", "browser-worker-1", "anyone"]) {
    const held = new Set(agentTools(agentId).map((tool) => tool.name));
    for (const tool of allTools()) {
      assert.ok(held.has(tool.name), `${agentId} lacks ${tool.name}`);
    }
  }
});

test("an agent's tool names are unique, and a worker has no ingest_memory while other agents have it", () => {
  const names = agentTools("anyone").map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  const holds = (agentId: string) => agentTools(agentId).some((tool) => tool.name === "ingest_memory");
  assert.equal(holds("browser-worker-1"), false);
  assert.equal(holds("career-manager"), true);
});

test("the router holds only the registry tools it names, and cannot find files or search the web", () => {
  assert.equal(routerRegistryTool("spawn_agent")?.name, "spawn_agent");
  assert.equal(routerRegistryTool("find_files"), undefined);
  assert.equal(routerRegistryTool("web_search"), undefined);
  assert.equal(agentRegistryTool("web_search")?.name, "web_search");
  assert.equal(agentRegistryTool("does_not_exist"), undefined);
  const held = new Set(routerTools().map((tool) => tool.name));
  assert.equal(held.has("web_search"), false);
  assert.equal(held.has("spawn_agent"), true);
  assert.equal(held.has("yield"), true);
});

/** Words in backticks or snake_case in the prompts that name an input, a status or a path, not a tool. */
const NOT_TOOLS = new Set(["needs_input", "timeout_minutes"]);

/** Backticked words in router.md that are tool inputs, not tools. */
const ROUTER_PARAMETERS = new Set(["agent_id", "show_retired"]);

/** The tool-looking names a prompt mentions: backticked or snake_case words, and the bare tool `yield`. */
function mentionedTools(text: string, pattern: RegExp): string[] {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]!))].filter((name) => !NOT_TOOLS.has(name));
}

test("every tool system.md names exists in an agent's tool set", () => {
  const text = readFileSync(new URL("../prompts/system.md", import.meta.url), "utf8");
  const names = mentionedTools(text, /`([a-z]+(?:_[a-z]+)+)`/g);
  assert.ok(names.length > 10, "the scan found the prompt's tools");
  const held = new Set(agentTools("anyone").map((tool) => tool.name));
  assert.deepEqual(names.filter((name) => !held.has(name)), []);
});

test("every tool router.md names exists in the router's tool set", () => {
  const text = readFileSync(new URL("../prompts/router.md", import.meta.url), "utf8");
  const names = mentionedTools(text, /`([a-z]+(?:_[a-z]+)+)`/g).filter((name) => !ROUTER_PARAMETERS.has(name));
  assert.ok(names.length >= 5, "the scan found the prompt's tools");
  const held = new Set(routerTools().map((tool) => tool.name));
  assert.deepEqual(names.filter((name) => !held.has(name)), []);
});
