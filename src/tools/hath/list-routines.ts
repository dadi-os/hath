import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { agentIdSchema } from "../../agent-id.js";
import { routines } from "../../db/schema.js";
import { toRoutineRecord } from "../../serialize.js";
import { defineTool } from "../types.js";
import { failWithoutAgentIdentity, ok, requireAgent } from "../shared.js";

const input = z.object({ agent_id: agentIdSchema.optional() }).strict();

/** List an agent's routines: the caller's own unless another is named. */
export const listRoutines = defineTool({
  name: "list_routines",
  description:
    "List the routines of an agent: title, procedure, time of day, weekdays, next and last run, soonest first. Yours by default; pass agent_id to read another agent's (reading is free, changing another's is not possible: each agent sets its own).",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { agent_id: { type: "string", description: "Whose routines; leave out for your own" } },
  },
  async handler(ctx, parsed) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    const agentId = parsed.agent_id ?? ctx.callerId;
    await requireAgent(ctx.db, agentId);
    const rows = await ctx.db
      .select()
      .from(routines)
      .where(and(eq(routines.agentId, agentId), eq(routines.active, true)))
      .orderBy(asc(routines.nextRunAt));
    return ok({ agent_id: agentId, routines: rows.map(toRoutineRecord) });
  },
});
