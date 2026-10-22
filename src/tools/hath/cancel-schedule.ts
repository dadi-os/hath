import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { scheduledMessages } from "../../db/schema.js";
import { defineTool } from "../types.js";
import { ok, fail, failWithoutAgentIdentity } from "../shared.js";

const input = z.object({
  schedule_id: z.string().uuid(),
});

/** Cancel a schedule the caller created. */
export const cancelSchedule = defineTool({
  name: "cancel_schedule",
  description: "Cancel a scheduled message you created. Fails if the id is unknown or not yours.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      schedule_id: { type: "string", description: "Id returned by schedule_message" },
    },
    required: ["schedule_id"],
  },
  async handler(ctx, parsed) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    const rows = await ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, parsed.schedule_id));
    const row = rows[0];
    if (!row) {
      return fail(`schedule ${parsed.schedule_id} not found`);
    }
    if (row.fromAgentId !== ctx.callerId) {
      return fail("only the creator may cancel a schedule");
    }
    await ctx.db
      .delete(scheduledMessages)
      .where(
        and(
          eq(scheduledMessages.id, parsed.schedule_id),
          eq(scheduledMessages.fromAgentId, ctx.callerId),
        ),
      );
    ctx.events.emit({ type: "schedules_changed", at: new Date().toISOString() });
    return ok({ cancelled: true, schedule_id: parsed.schedule_id });
  },
});
