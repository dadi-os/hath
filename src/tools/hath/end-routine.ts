import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { routines } from "../../db/schema.js";
import { recordActivity } from "../../runtime/activity.js";
import { defineTool } from "../types.js";
import { fail, failWithoutAgentIdentity, ok } from "../shared.js";

const input = z.object({ title: z.string().min(1) }).strict();

/** End one of the caller's own routines. */
export const endRoutine = defineTool({
  name: "end_routine",
  description:
    "End one of your own routines by its title: it stops running. Setting a routine with the same title later starts it again. Returns { title, ended }.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: { title: { type: "string", description: "The title of one of your routines" } },
  },
  async handler(ctx, parsed) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    const ended = await ctx.db
      .update(routines)
      .set({ active: false })
      .where(and(eq(routines.agentId, ctx.callerId), eq(routines.title, parsed.title), eq(routines.active, true)))
      .returning({ id: routines.id });
    if (ended.length === 0) {
      return fail(`you have no routine titled "${parsed.title}"`);
    }
    await recordActivity(ctx.db, { agentId: ctx.callerId, jobId: ctx.jobId, kind: "routine", subject: parsed.title, digest: "ended" });
    ctx.events.emit({ type: "schedules_changed", at: new Date().toISOString() });
    return ok({ title: parsed.title, ended: true });
  },
});
