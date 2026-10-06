/**
 * Embedded `modify_agent`: every agent can rewrite its own purpose or retire,
 * and manage its direct children the same way; retirement is one-way. Not
 * grantable, and not the router's — the router hands work off; agents reshape
 * themselves.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { agents } from "../db/schema.js";
import { agentIdSchema } from "../agent-id.js";
import {
  fail,
  failWithoutAgentIdentity,
  ok,
  requireActiveAgent,
  type ToolContext,
  type ToolExecResult,
} from "../tools/shared.js";
import type { DwarTool } from "../types/domain.js";
import { MODIFY_AGENT } from "../types/domain.js";

const modifyAgentInput = z
  .object({
    agent_id: agentIdSchema,
    system_prompt: z.string().min(1).optional(),
    retire: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => value.system_prompt !== undefined || value.retire !== undefined, {
    message: "system_prompt or retire is required",
  });

/** Change the caller's or a direct child's system prompt, or retire it for good. */
export const modifyAgentTool: DwarTool = {
  name: MODIFY_AGENT,
  description:
    "Change your own system prompt, or a direct child's, or retire one. Use system_prompt when your job itself changes — you are told to take on new responsibilities, organize differently, or stop doing something — so the change outlives this wake. The new system_prompt replaces the old one whole, so carry forward everything that still holds. retire true retires the agent permanently: it never runs again, cannot be messaged or changed, and its id is never reused. Ids are immutable and cannot be renamed.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      agent_id: {
        type: "string",
        description: "Your own id or a direct child's; immutable kebab-case",
      },
      system_prompt: { type: "string", description: "The full replacement prompt" },
      retire: {
        type: "boolean",
        enum: [true],
        description: "Retire the agent permanently; there is no way back",
      },
    },
    required: ["agent_id"],
  },
};

/** runModifyAgent applies modify_agent for an agent caller, limited to itself and its direct children. */
export async function runModifyAgent(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const parsed = modifyAgentInput.parse(raw);
  const target = await requireActiveAgent(ctx.db, parsed.agent_id);
  if (target.id !== ctx.callerId && target.parentAgentId !== ctx.callerId) {
    return fail("modify_agent is limited to yourself or your direct children");
  }

  const oldPrompt = target.systemPrompt;
  const newPrompt = parsed.system_prompt ?? oldPrompt;
  const retired = parsed.retire === true;
  const now = new Date();
  await ctx.db
    .update(agents)
    .set({ systemPrompt: newPrompt, active: !retired, updatedAt: now })
    .where(eq(agents.id, target.id));

  ctx.events.emit({
    type: "agent_modified",
    agent_id: target.id,
    name: target.id,
    active: !retired,
    at: now.toISOString(),
  });

  return ok(
    { agent_id: target.id, old_system_prompt: oldPrompt, retired },
    { old_system_prompt: oldPrompt, new_system_prompt: newPrompt },
  );
}
