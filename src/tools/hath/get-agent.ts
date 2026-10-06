import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { agentIdSchema } from "../../agent-id.js";
import { agentTools, tools } from "../../db/schema.js";
import { defineTool } from "../types.js";
import { ok, fail, requireAgent } from "../shared.js";

const input = z.object({
  agent_id: agentIdSchema,
});

/** Read id, system prompt, parent, retired flag, and tool names for self or a direct child (any agent as the router). */
export const getAgent = defineTool({
  name: "get_agent",
  description:
    "Read an agent's id, system prompt, parent, whether it is retired, and the names of the tools it holds. Only the caller or its direct children are allowed. As the router, any agent is allowed.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "Self or a direct child (any agent as the router); immutable kebab-case id",
      },
    },
    required: ["agent_id"],
  },
  async handler(ctx, parsed) {
    const target = await requireAgent(ctx.db, parsed.agent_id);
    if (
      ctx.callerId !== null &&
      target.id !== ctx.callerId &&
      target.parentAgentId !== ctx.callerId
    ) {
      return fail("get_agent is limited to self or direct children");
    }

    const held = await ctx.db
      .select({ name: tools.name })
      .from(agentTools)
      .innerJoin(tools, eq(agentTools.toolId, tools.id))
      .where(eq(agentTools.agentId, target.id))
      .orderBy(asc(tools.name));

    return ok({
      name: target.id,
      system_prompt: target.systemPrompt,
      parent_agent_id: target.parentAgentId,
      retired: !target.active,
      tools: held.map((row) => row.name),
    });
  },
});
