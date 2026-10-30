import { z } from "zod";
import { agentIdSchema } from "../../agent-id.js";
import { allTools } from "../registry.js";
import { defineTool } from "../types.js";
import { ok, fail, requireAgent } from "../shared.js";

const input = z.object({
  agent_id: agentIdSchema,
});

/** Read id, system prompt, parent, retired flag, and tool names for self or a direct child (any agent as the router). */
export const getAgent = defineTool({
  name: "get_agent",
  description:
    "Read yourself or one of your direct children (any agent, as the router): id, charter (system prompt), parent, whether it is retired, and the names of the registry tools (the same for every agent).",
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

    return ok({
      name: target.id,
      system_prompt: target.systemPrompt,
      parent_agent_id: target.parentAgentId,
      retired: !target.active,
      tools: allTools().map((tool) => tool.name),
    });
  },
});
