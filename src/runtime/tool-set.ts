import type { DwarTool } from "../types/domain.js";
import { GET_AGENT, READ_FILE, SPAWN_AGENT } from "../types/domain.js";
import { allTools, findTool } from "../tools/registry.js";
import { asDwarTool, type ToolDefinition } from "../tools/types.js";
import { ingestMemoryTool, recallMemoryTool } from "./memory.js";
import { manageAgentTool, modifyAgentPromptTool } from "./modify.js";
import { routerForwardAttachmentTool, routerSendMessageTool } from "./router.js";
import { sendTool } from "./send.js";
import { listAgentsTool, yieldTool } from "./tools.js";
import { waitTool } from "./watches.js";

/** A worker's id names its pool and task (`browser-worker-ibio-150-quiz-2`), per the system doctrine. */
export const WORKER_ID = /(^|-)worker-/;

/** The registry tools the router holds. */
const ROUTER_REGISTRY_TOOLS = [READ_FILE, GET_AGENT, "get_logs", "get_messages", SPAWN_AGENT] as const;

/** The registry tool an agent may call under this name, or undefined when it holds none. */
export function agentRegistryTool(name: string): ToolDefinition | undefined {
  return findTool(name);
}

/** The registry tools the router holds. */
function routerRegistryTools(): ToolDefinition[] {
  return ROUTER_REGISTRY_TOOLS.map((name) => {
    const tool = findTool(name);
    if (!tool) {
      throw new Error(`the router names ${name}, which is not in the registry`);
    }
    return tool;
  });
}

/** The registry tool the router may call under this name, or undefined when it holds none. */
export function routerRegistryTool(name: string): ToolDefinition | undefined {
  return routerRegistryTools().find((tool) => tool.name === name);
}

/**
 * agentTools is every tool an agent holds, and the only place that says which: the registry
 * tools and send_message, list_agents, wait, the memory tools, the agent-management tools and
 * yield. A worker gets no `ingest_memory`: it reports what it found to the agent that owns the domain.
 */
export function agentTools(agentId: string): DwarTool[] {
  return [
    ...allTools().map(asDwarTool),
    sendTool,
    listAgentsTool,
    waitTool,
    recallMemoryTool,
    ...(WORKER_ID.test(agentId) ? [] : [ingestMemoryTool]),
    manageAgentTool,
    modifyAgentPromptTool,
    yieldTool,
  ];
}

/** routerTools is every tool the router holds. */
export function routerTools(): DwarTool[] {
  return [routerSendMessageTool, routerForwardAttachmentTool, listAgentsTool, recallMemoryTool, ...routerRegistryTools().map(asDwarTool), yieldTool];
}
