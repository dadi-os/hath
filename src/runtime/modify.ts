/**
 * Embedded `modify_agent`: every agent can rewrite its own purpose or retire,
 * and manage its direct children the same way; only a parent can reactivate a
 * retired child. Not grantable, and not the router's — the router hands work
 * off; agents reshape themselves.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { agents } from "../db/schema.js";
import { HathError } from "../errors.js";
import { agentIdSchema } from "../agent-id.js";
import {
  fail,
  failWithoutAgentIdentity,
  ok,
  requireAgent,
  type ToolContext,
  type ToolExecResult,
} from "../tools/shared.js";
import type { DwarTool } from "../types/domain.js";
import { MODIFY_AGENT } from "../types/domain.js";

const modifyAgentInput = z
  .object({
    agent_id: agentIdSchema,
    system_prompt: z.string().min(1).optional(),
    retired: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.system_prompt !== undefined || value.retired !== undefined, {
    message: "system_prompt or retired is required",
  });

/** Change the caller's or a direct child's system prompt, retire it, or reactivate a retired child. */
export const modifyAgentTool: DwarTool = {
  name: MODIFY_AGENT,
  description:
    "Change your own system prompt or a direct child's, retire one, or reactivate a retired child. Use system_prompt when your job itself changes — you are told to take on new responsibilities, organize differently, or stop doing something — so the change outlives this wake. The new system_prompt replaces the old one whole, so carry forward everything that still holds; it takes effect from the agent's next wake, and the wake in progress keeps its current prompt. retired true retires the agent: it stops running and cannot be messaged or changed. retired false reactivates a retired direct child with its prompt, tools and history intact; only its parent can. Ids are immutable and cannot be renamed.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      agent_id: {
        type: "string",
        description: "Your own id or a direct child's; immutable kebab-case",
      },
      system_prompt: { type: "string", description: "The full replacement prompt" },
      retired: {
        type: "boolean",
        description: "true retires the agent; false reactivates a retired direct child",
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
  const target = await requireAgent(ctx.db, parsed.agent_id);
  if (target.id !== ctx.callerId && target.parentAgentId !== ctx.callerId) {
    return fail("modify_agent is limited to yourself or your direct children");
  }
  if (!target.active && !(target.parentAgentId === ctx.callerId && parsed.retired === false)) {
    throw new HathError(
      409,
      "retired",
      `agent ${target.id} is retired; only its parent can reactivate it, with retired false`,
    );
  }

  const oldPrompt = target.systemPrompt;
  const newPrompt = parsed.system_prompt ?? oldPrompt;
  const retired = parsed.retired ?? !target.active;
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
    { agent_id: target.id, retired },
    { old_system_prompt: oldPrompt, new_system_prompt: newPrompt },
  );
}
