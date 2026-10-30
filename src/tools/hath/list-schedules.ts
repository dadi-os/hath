import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { scheduledMessages } from "../../db/schema.js";
import { toScheduledMessageRecord } from "../../serialize.js";
import { defineTool } from "../types.js";
import { ok, failWithoutAgentIdentity } from "../shared.js";

const input = z.object({}).default({});

/** List schedules created by the caller. */
export const listSchedules = defineTool({
  name: "list_schedules",
  description: "List every scheduled message you created: id, recipient, content, next run_at and interval, soonest first.",
  input,
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async handler(ctx) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    const rows = await ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.fromAgentId, ctx.callerId))
      .orderBy(asc(scheduledMessages.runAt));
    return ok({ schedules: rows.map(toScheduledMessageRecord) });
  },
});
