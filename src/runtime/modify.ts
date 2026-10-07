/**
 * Embedded agent self-management: `manage_agent` retires an agent or reactivates
 * a retired child, and `modify_agent_prompt` edits a prompt in place. Every
 * agent can change itself and its direct children; only a parent can reactivate
 * a retired child. Not grantable, and not the router's — the router hands work
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
import { MANAGE_AGENT, MODIFY_AGENT_PROMPT } from "../types/domain.js";

const manageAgentInput = z
  .object({
    agent_id: agentIdSchema,
    retired: z.boolean(),
  })
  .strict();

const modifyAgentPromptInput = z
  .object({
    agent_id: agentIdSchema,
    edits: z
      .array(
        z
          .object({
            old_string: z.string().min(1),
            new_string: z.string(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** Retire the caller or a direct child, or reactivate a retired direct child. */
export const manageAgentTool: DwarTool = {
  name: MANAGE_AGENT,
  description:
    "Retire yourself or a direct child, or reactivate a retired direct child. retired true retires the agent: it stops running and cannot be messaged or changed. retired false reactivates a retired direct child with its prompt, tools and history intact; only its parent can. The prompt is untouched either way — change it with modify_agent_prompt.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      agent_id: {
        type: "string",
        description: "Your own id or a direct child's; immutable kebab-case",
      },
      retired: {
        type: "boolean",
        description: "true retires the agent; false reactivates a retired direct child",
      },
    },
    required: ["agent_id", "retired"],
  },
};

/** Edit the caller's or a direct child's system prompt by exact-match replacement. */
export const modifyAgentPromptTool: DwarTool = {
  name: MODIFY_AGENT_PROMPT,
  description:
    "Edit your own system prompt or a direct child's. Use it when your job itself changes — you are told to take on new responsibilities, organize differently, or stop doing something — so the change outlives this wake. Each edit replaces exactly one occurrence of old_string with new_string; edits apply in order, each against the prompt the previous one left. If any old_string matches zero or many times nothing is saved and the tool errors with the match count — widen or narrow old_string and retry. To add a section, anchor on nearby text and repeat it in new_string; to delete, pass an empty new_string. Read the current prompt with get_agent. The change takes effect from the agent's next wake; the wake in progress keeps its current prompt.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      agent_id: {
        type: "string",
        description: "Your own id or a direct child's; immutable kebab-case",
      },
      edits: {
        type: "array",
        minItems: 1,
        description: "Exact replacements, applied in order",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            old_string: { type: "string", description: "Exact prompt text that must occur once" },
            new_string: { type: "string", description: "Replacement text" },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["agent_id", "edits"],
  },
};

/**
 * requireManagedAgent loads the agent a self-management tool names: the caller
 * itself or a direct child (else `403 forbidden`), active unless `reactivating`
 * — a parent bringing a retired child back (else `409 retired`).
 */
async function requireManagedAgent(
  ctx: ToolContext,
  callerId: string,
  tool: string,
  agentId: string,
  reactivating: boolean,
) {
  const target = await requireAgent(ctx.db, agentId);
  if (target.id !== callerId && target.parentAgentId !== callerId) {
    throw new HathError(403, "forbidden", `${tool} is limited to yourself or your direct children`);
  }
  if (!target.active && !(reactivating && target.parentAgentId === callerId)) {
    throw new HathError(
      409,
      "retired",
      `agent ${target.id} is retired; only its parent can reactivate it, with manage_agent retired false`,
    );
  }
  return target;
}

/**
 * runManageAgent retires or reactivates an agent for an agent caller, limited to
 * itself and its direct children.
 */
export async function runManageAgent(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const parsed = manageAgentInput.parse(raw);
  const target = await requireManagedAgent(
    ctx,
    ctx.callerId,
    MANAGE_AGENT,
    parsed.agent_id,
    !parsed.retired,
  );
  const now = new Date();
  await ctx.db
    .update(agents)
    .set({ active: !parsed.retired, updatedAt: now })
    .where(eq(agents.id, target.id));

  ctx.events.emit({
    type: "agent_modified",
    agent_id: target.id,
    name: target.id,
    active: !parsed.retired,
    at: now.toISOString(),
  });

  return ok({ agent_id: target.id, retired: parsed.retired });
}

/**
 * runModifyAgentPrompt applies exact-match edits to an active agent's prompt for
 * an agent caller, limited to itself and its direct children. Every edit must
 * match exactly once or nothing is saved.
 */
export async function runModifyAgentPrompt(
  ctx: ToolContext,
  raw: unknown,
): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const parsed = modifyAgentPromptInput.parse(raw);
  const target = await requireManagedAgent(
    ctx,
    ctx.callerId,
    MODIFY_AGENT_PROMPT,
    parsed.agent_id,
    false,
  );
  const oldPrompt = target.systemPrompt;
  let newPrompt = oldPrompt;
  for (const [index, edit] of parsed.edits.entries()) {
    const matches = newPrompt.split(edit.old_string).length - 1;
    if (matches !== 1) {
      return fail(
        `edit ${index + 1}: expected exactly 1 match of old_string, got ${matches}; nothing was saved`,
      );
    }
    newPrompt = newPrompt.replace(edit.old_string, () => edit.new_string);
  }
  if (newPrompt.trim() === "") {
    return fail("edits would leave the system prompt empty; nothing was saved");
  }
  const now = new Date();
  await ctx.db
    .update(agents)
    .set({ systemPrompt: newPrompt, updatedAt: now })
    .where(eq(agents.id, target.id));

  ctx.events.emit({
    type: "agent_modified",
    agent_id: target.id,
    name: target.id,
    active: target.active,
    at: now.toISOString(),
  });

  return ok(
    { agent_id: target.id, edits_applied: parsed.edits.length },
    { old_system_prompt: oldPrompt, new_system_prompt: newPrompt },
  );
}
