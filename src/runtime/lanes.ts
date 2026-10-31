import type { DwarTool, Lane } from "../types/domain.js";
import { CONTROL_DEVICE, FIND_FILES, GET_AGENT, GET_DEVICE, READ_FILE, SPAWN_AGENT } from "../types/domain.js";
import { allTools, findTool } from "../tools/registry.js";
import { asDwarTool, type ToolDefinition } from "../tools/types.js";
import { ingestMemoryTool, recallMemoryTool } from "./memory.js";
import { manageAgentTool, modifyAgentPromptTool } from "./modify.js";
import { messageTool } from "./outbox.js";
import { routerForwardAttachmentTool, routerSendMessageTool } from "./router.js";
import { sendTool } from "./send.js";
import { listAgentsTool, steerWorkTool, yieldTool } from "./tools.js";
import { waitTool } from "./watches.js";

/** A worker's id names its pool and task (`browser-worker-ibio-150-quiz-2`), per the system doctrine. */
export const WORKER_ID = /(^|-)worker-/;

/** The registry tools the process lane holds; the work lane holds every one. */
const PROCESS_REGISTRY_TOOLS = [
  READ_FILE,
  FIND_FILES,
  "get_logs",
  "web_search",
  "web_fetch",
  GET_AGENT,
  "list_schedules",
  GET_DEVICE,
  CONTROL_DEVICE,
] as const;

/** The registry tools the router lane holds. */
const ROUTER_REGISTRY_TOOLS = [READ_FILE, GET_AGENT, "get_logs", SPAWN_AGENT] as const;

/** The registry tools a lane holds besides its own: all of them for work, a named few otherwise. */
function registryToolsFor(lane: Lane): ToolDefinition[] {
  if (lane === "work") {
    return allTools();
  }
  const names: readonly string[] = lane === "process" ? PROCESS_REGISTRY_TOOLS : ROUTER_REGISTRY_TOOLS;
  return names.map((name) => {
    const tool = findTool(name);
    if (!tool) {
      throw new Error(`${lane} lane names ${name}, which is not in the registry`);
    }
    return tool;
  });
}

/** The registry tool this lane may call under this name, or undefined when it holds none. */
export function laneRegistryTool(lane: Lane, name: string): ToolDefinition | undefined {
  return registryToolsFor(lane).find((tool) => tool.name === name);
}

/**
 * toolsForLane is every tool a lane may call, and the only place that says which: the
 * lane's own tools (the router's send_message and forward_attachment, the process lane's
 * send and steer_work, the work lane's message, wait, memory and agent-management tools)
 * and its registry tools. `agentId` is null on the router lane; a worker's work lane gets
 * no `ingest_memory`: it reports what it found to the agent that owns the domain.
 */
export function toolsForLane(agentId: string | null, lane: Lane): DwarTool[] {
  const registry = registryToolsFor(lane).map(asDwarTool);
  switch (lane) {
    case "router":
      return [routerSendMessageTool, routerForwardAttachmentTool, listAgentsTool, recallMemoryTool, ...registry, yieldTool];
    case "process":
      return [sendTool, steerWorkTool, ...registry, recallMemoryTool, listAgentsTool, yieldTool];
    case "work":
      return [
        ...registry,
        messageTool,
        listAgentsTool,
        waitTool,
        recallMemoryTool,
        ...(agentId !== null && WORKER_ID.test(agentId) ? [] : [ingestMemoryTool]),
        manageAgentTool,
        modifyAgentPromptTool,
        yieldTool,
      ];
  }
}
