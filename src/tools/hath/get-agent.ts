import { z } from "zod";
import { agentIdSchema } from "../../agent-id.js";
import { defineTool } from "../types.js";
import { ok, requireAgent } from "../shared.js";

const input = z.object({
  agent_id: agentIdSchema,
});

/** Read id, system prompt, parent, and retired flag for any agent. */
export const getAgent = defineTool({
  name: "get_agent",
  description:
    "Read any agent: id, charter (system prompt), parent, whether it is retired.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "Immutable kebab-case id",
      },
    },
    required: ["agent_id"],
  },
  async handler(ctx, parsed) {
    const target = await requireAgent(ctx.db, parsed.agent_id);
    return ok({
      name: target.id,
      system_prompt: target.systemPrompt,
      parent_agent_id: target.parentAgentId,
      retired: !target.active,
    });
  },
});
