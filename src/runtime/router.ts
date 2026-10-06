/**
 * The router's lane. The router is the null identity — the same as Ankur — so
 * everything it sends reaches its agent as a message from him. It runs one model
 * loop per utterance with the same composer and step machinery as agent lanes,
 * and nothing here caps what it does: how it gathers context and hands work off
 * is its prompt's job (`prompts/router.md`). The loop ends when it yields.
 */

import { z } from "zod";
import { agentIdSchema } from "../agent-id.js";
import { spawnAgent } from "../tools/hath/spawn-agent.js";
import { embeddedAgentTools } from "../tools/registry.js";
import { fail, ok, requireActiveAgent, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import { asDwarTool, type ToolDefinition } from "../tools/types.js";
import type { DwarTool, DwarToolUseBlock, RoutedMessage } from "../types/domain.js";
import { RECALL_MEMORY, SEND_MESSAGE } from "../types/domain.js";
import { deliverUserMessage } from "./deliver.js";
import { recallMemoryTool, runRecallMemory } from "./memory.js";
import { listAgentsTool, yieldTool } from "./tools.js";

/** Lock and wake key for the router; not a valid agent id, so it never collides with one. */
export const ROUTER_KEY = "(router)";

const routerSendInput = z
  .object({
    to_agent_id: agentIdSchema,
    content: z.string().min(1),
  })
  .strict();

/** The router's send: persist and deliver as Ankur. There is no separate intent step. */
const routerSendMessageTool: DwarTool = {
  name: SEND_MESSAGE,
  description:
    "Send a message to an agent as Ankur. It lands in that agent's thread from him and wakes it; a retired agent cannot be messaged. Write it in his first person. Does not end your turn — call yield when you are done.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      to_agent_id: { type: "string", description: "Exact kebab-case agent id" },
      content: { type: "string", description: "The message, exactly as it should arrive" },
    },
    required: ["to_agent_id", "content"],
  },
};

/**
 * Registry-style tools the router holds without grants: spawning roots and the
 * embedded agent-management set.
 */
function routerRegistryTools(): ToolDefinition[] {
  return [
    spawnAgent as unknown as ToolDefinition,
    ...embeddedAgentTools(),
  ];
}

/** Every tool name the router may run, lane or CLI (`as_agent_id: "router"`). */
export function routerToolNames(): Set<string> {
  return new Set(routerRegistryTools().map((tool) => tool.name));
}

/** What the model sees on the router lane. */
export function routerLaneTools(): DwarTool[] {
  return [
    routerSendMessageTool,
    listAgentsTool,
    recallMemoryTool,
    ...routerRegistryTools().map(asDwarTool),
    yieldTool,
  ];
}

/** Run one router-lane tool call. list_agents and yield are handled before this. */
export async function runRouterTool(
  ctx: ToolContext,
  call: DwarToolUseBlock,
): Promise<ToolExecResult> {
  if (call.name === SEND_MESSAGE) {
    return runRouterSend(ctx, call.input);
  }
  if (call.name === RECALL_MEMORY) {
    return runRecallMemory(ctx, call.input);
  }
  const definition = routerRegistryTools().find((tool) => tool.name === call.name);
  if (!definition) {
    return fail(`unknown router tool: ${call.name}`);
  }
  return definition.handler(ctx, definition.input.parse(call.input));
}

/** runRouterSend delivers one message as Ankur; a retired recipient is a `retired` error. */
async function runRouterSend(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  const input = routerSendInput.parse(raw);
  const target = await requireActiveAgent(ctx.db, input.to_agent_id);
  const row = await deliverUserMessage(
    {
      db: ctx.db,
      transcript: ctx.transcript,
      events: ctx.events,
      enqueueConversation: ctx.enqueueConversation,
    },
    target.id,
    input.content,
  );
  const sent: RoutedMessage = {
    to_agent_id: target.id,
    content: row.content,
    seq: row.seq,
    created_at: row.createdAt.toISOString(),
  };
  return ok(sent);
}
