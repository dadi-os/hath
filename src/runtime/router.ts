/**
 * The router. The router is the null identity — the same as Ankur — so
 * everything it sends reaches its agent as a message from him. It runs one model
 * loop per utterance with the same composer and step machinery as an agent,
 * and nothing here caps what it does: how it gathers context and hands work off
 * is its prompt's job (`prompts/router.md`). The loop ends when it yields.
 */

import { z } from "zod";
import { agentIdSchema } from "../agent-id.js";
import { fail, ok, requireActiveAgent, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import type { DwarTool, DwarToolUseBlock, RoutedMessage } from "../types/domain.js";
import { RECALL_MEMORY, SEND_MESSAGE } from "../types/domain.js";
import { deliverUserMessage } from "./deliver.js";
import { runRecallMemory } from "./memory.js";
import { deliverDeps } from "./async.js";
import { routerRegistryTool } from "./tool-set.js";

/** Lock and wake key for the router; not a valid agent id, so it never collides with one. */
export const ROUTER_KEY = "(router)";

const routerSendInput = z
  .object({
    to_agent_id: agentIdSchema,
    content: z.string().min(1),
  })
  .strict();

/** The router's send: persist and deliver as Ankur. There is no separate intent step. */
export const routerSendMessageTool: DwarTool = {
  name: SEND_MESSAGE,
  description:
    "Send a message to an agent as Ankur. It lands in that agent's thread from him and wakes it; a retired agent cannot be messaged. Write it in his first person. A file Ankur sent arrives as a [name](box://path) link in his message: put that link in the content to hand it on, never its contents. Does not end your turn — call yield when you are done.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      to_agent_id: { type: "string", description: "Exact kebab-case agent id" },
      content: { type: "string", description: "The message, exactly as it should arrive, with any file as its link" },
    },
    required: ["to_agent_id", "content"],
  },
};

/** Run one router tool call. list_agents and yield are handled before this. */
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
  const definition = routerRegistryTool(call.name);
  if (!definition) {
    return fail(`unknown router tool: ${call.name}`);
  }
  return definition.handler(ctx, definition.input.parse(call.input));
}

/** runRouterSend delivers one message as Ankur; a retired recipient is a `retired` error. */
async function runRouterSend(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  const input = routerSendInput.parse(raw);
  const target = await requireActiveAgent(ctx.db, input.to_agent_id);
  const row = await deliverUserMessage(deliverDeps(ctx), target.id, input.content);
  const sent: RoutedMessage = {
    to_agent_id: target.id,
    content: row.content,
    seq: row.seq,
    created_at: row.createdAt.toISOString(),
  };
  return ok(sent, { message_id: row.id });
}
