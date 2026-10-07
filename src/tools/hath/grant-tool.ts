import { sql } from "drizzle-orm";
import { z } from "zod";
import { agentIdSchema } from "../../agent-id.js";
import { agentTools } from "../../db/schema.js";
import { defineTool } from "../types.js";
import { findTool } from "../registry.js";
import { toolId } from "../sync.js";
import { ok, fail, requireAgent } from "../shared.js";

const input = z.object({
  agent_id: agentIdSchema,
  tools: z
    .array(
      z.object({
        tool_name: z.string().min(1),
        usage: z.string().min(1),
      }),
    )
    .min(1),
});

/**
 * Grant registry tools to a direct child, all or none. Embedded for every agent;
 * the router's children are the roots.
 */
export const grantTool = defineTool({
  name: "grant_tool",
  description:
    "Give one of your direct children one or more tools in one call (the router's direct children are the root agents). Each usage explains when and why that specific agent should reach for that tool, which the child sees alongside the tool's own description; granting a tool it already holds replaces its usage. If any tool name is unknown nothing is granted. When you are unsure of exact registry names for a suite (chaavi_, browser_, terminal_, …), call list_tools first.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "A direct child of yours; immutable kebab-case id",
      },
      tools: {
        type: "array",
        minItems: 1,
        description: "The tools to grant; one entry for a single tool",
        items: {
          type: "object",
          properties: {
            tool_name: { type: "string", description: "Registry tool name" },
            usage: {
              type: "string",
              description: "When and why this agent should use this tool",
            },
          },
          required: ["tool_name", "usage"],
        },
      },
    },
    required: ["agent_id", "tools"],
  },
  async handler(ctx, parsed) {
    const target = await requireAgent(ctx.db, parsed.agent_id);
    if (ctx.callerKind !== "user" && target.parentAgentId !== ctx.callerId) {
      return fail("grant_tool is limited to your direct children");
    }
    const names = parsed.tools.map((tool) => tool.tool_name);
    const repeated = names.filter((name, index) => names.indexOf(name) !== index);
    if (repeated.length > 0) {
      const listed = [...new Set(repeated)].join(", ");
      return fail(`${listed} listed more than once; nothing was granted`);
    }
    const unknown = names.filter((name) => !findTool(name));
    if (unknown.length > 0) {
      return fail(`no tool named ${unknown.join(", ")}; nothing was granted`);
    }
    await ctx.db
      .insert(agentTools)
      .values(
        parsed.tools.map((tool) => ({
          agentId: parsed.agent_id,
          toolId: toolId(tool.tool_name),
          usage: tool.usage,
        })),
      )
      .onConflictDoUpdate({
        target: [agentTools.agentId, agentTools.toolId],
        set: { usage: sql`excluded.usage` },
      });
    return ok({ agent_id: parsed.agent_id, tool_names: names });
  },
});
