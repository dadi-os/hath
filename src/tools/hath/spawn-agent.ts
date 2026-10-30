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
    "Create a new agent as your child (as the router, a root agent). Give it an immutable kebab-case id named for what it owns, a charter (system_prompt: its purpose, who it works for and with), and for a standing agent its directory description, which every agent sees. It starts with the tools every agent holds (messaging, memory, scheduling, files, web search and fetch, browser and terminal tasks, and the house tools). Returns { agent_id }. Fails if the id is taken.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "Immutable kebab-case agent id (lowercase letters, digits, single hyphens), such as finance-specialist. Name it for the area it owns, not the task at hand. This is how other agents address it.",
      },
      system_prompt: {
        type: "string",
        description:
          "The child's charter, for both of its lanes: its purpose, what it owns, and who it works for and with.",
      },
      description: {
        type: "string",
        description: `The child's agent directory entry, which every agent sees. Give every standing agent one. ${DESCRIPTION_TEMPLATE}`,
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
