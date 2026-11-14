import { randomUUID } from "node:crypto";
import { z } from "zod";
import { reminders } from "../../db/schema.js";
import { recordActivity } from "../../runtime/activity.js";
import { defineTool } from "../types.js";
import { fail, failWithoutAgentIdentity, ok } from "../shared.js";

const input = z.object({ at: z.string().datetime({ offset: true }), note: z.string().min(1) }).strict();

/** A later step of the current job. */
export const remindMe = defineTool({
  name: "remind_me",
  description:
    "Come back to this job later: at the given time you are woken in this same job, with its requester, what you did in it and the note you left. Use it for a later step of a job you are in (check back at six, remind him Friday). It is one-shot and yours. at is ISO 8601 with offset and must be in the future. Returns { reminder_id, at }.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["at", "note"],
    properties: {
      at: { type: "string", description: "ISO 8601 datetime with offset, in the future" },
      note: { type: "string", description: "What to do when you come back, written for yourself" },
    },
  },
  async handler(ctx, parsed) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    if (ctx.jobId === null) {
      return fail("you are in no job, so there is nothing to come back to; set a routine for a standing duty");
    }
    const runAt = new Date(parsed.at);
    if (!(runAt.getTime() > Date.now())) {
      return fail("at must be in the future");
    }
    const id = randomUUID();
    await ctx.db.insert(reminders).values({ id, agentId: ctx.callerId, jobId: ctx.jobId, note: parsed.note, runAt });
    await recordActivity(ctx.db, { agentId: ctx.callerId, jobId: ctx.jobId, kind: "reminder", subject: runAt.toISOString(), digest: `set: ${parsed.note}` });
    ctx.events.emit({ type: "schedules_changed", at: new Date().toISOString() });
    return ok({ reminder_id: id, at: runAt.toISOString() });
  },
});
