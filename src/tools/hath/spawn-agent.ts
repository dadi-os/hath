import { z } from "zod";
import { agents } from "../../db/schema.js";
import { agentIdSchema } from "../../agent-id.js";
import { DESCRIPTION_TEMPLATE, descriptionSchema } from "../../runtime/directory.js";
import { defineTool } from "../types.js";
import { ok, fail, requireAgent, isUniqueViolation } from "../shared.js";

const input = z.object({
  id: agentIdSchema,
  system_prompt: z.string().min(1),
  description: descriptionSchema.optional(),
});

/** Create a child of the caller, or a root when the caller is the router. */
export const spawnAgent = defineTool({
  name: "hath_spawn_agent",
  description:
    "Create a child agent with the caller as its parent. When called as the router, creates a root (parent_agent_id null). The child starts with no granted tools — use grant_tool afterward to give it capabilities. id is the immutable kebab-case address (e.g. browser-manager, browser-worker-cse-431); it cannot be renamed later.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "Immutable kebab-case agent id (lowercase letters, digits, single hyphens), e.g. browser-manager or coding-worker-yaad. Name it for the area it owns, not the task at hand. This is how other agents address it.",
      },
      system_prompt: {
        type: "string",
        description:
          "Prompt for both of the child's lanes. Write one that fits the job you are spawning it for.",
      },
      description: {
        type: "string",
        description: `The child's agent directory entry, which every agent sees. Required for a standing agent (a specialist, manager or thread); leave it out for a worker. ${DESCRIPTION_TEMPLATE}`,
      },
    },
    required: ["id", "system_prompt"],
  },
  async handler(ctx, parsed) {
    if (ctx.callerId !== null) {
      await requireAgent(ctx.db, ctx.callerId);
    }
    try {
      await ctx.db.insert(agents).values({
        id: parsed.id,
        systemPrompt: parsed.system_prompt,
        description: parsed.description ?? null,
        parentAgentId: ctx.callerId,
        active: true,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return fail(`an agent with id ${parsed.id} already exists`);
      }
      throw err;
    }
    ctx.events.emit({
      type: "agent_spawned",
      agent_id: parsed.id,
      parent_agent_id: ctx.callerId,
      name: parsed.id,
      at: new Date().toISOString(),
    });
    return ok({ agent_id: parsed.id });
  },
});
