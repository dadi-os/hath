import { randomUUID } from "node:crypto";
import { z } from "zod";
import { routines } from "../../db/schema.js";
import { cadenceLabel, nextRunAt } from "../../runtime/routines.js";
import { recordActivity } from "../../runtime/activity.js";
import { WEEKDAYS } from "../../types/domain.js";
import { defineTool } from "../types.js";
import { failWithoutAgentIdentity, ok } from "../shared.js";

const input = z
  .object({
    title: z.string().min(1),
    procedure: z.string().min(1),
    at: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "at must be HH:MM, 24-hour"),
    days: z.array(z.enum(WEEKDAYS)).min(1).optional(),
  })
  .strict();

/** Set or change one of the caller's own routines. */
export const setRoutine = defineTool({
  name: "set_routine",
  description:
    "Set a standing duty of your own, or change one by giving its title again. A routine is yours: when it runs, nobody is waiting on an answer, and what it learns goes to memory. procedure is what to read, what to record and when it is done, written for yourself. at is the local time of day (HH:MM, 24-hour, the box's zone) and days the weekdays (mon, tue, wed, thu, fri, sat, sun); leave days out for every day. A change to the box's clock for daylight saving keeps the wall time. There is no recipient: a routine cannot be set for someone else, so to have another agent run one, ask it and it sets its own. Returns { title, cadence, next_run_at }.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "procedure", "at"],
    properties: {
      title: { type: "string", description: "The routine's name, unique among yours; the same title changes it" },
      procedure: { type: "string", description: "What to do each time it runs, written for yourself" },
      at: { type: "string", description: "Local time of day, HH:MM, 24-hour" },
      days: {
        type: "array",
        items: { type: "string", enum: [...WEEKDAYS] },
        minItems: 1,
        description: "Weekdays it runs on; leave out for every day",
      },
    },
  },
  async handler(ctx, parsed) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    const days = parsed.days ?? null;
    const next = nextRunAt(parsed.at, days, new Date());
    await ctx.db
      .insert(routines)
      .values({ id: randomUUID(), agentId: ctx.callerId, title: parsed.title, procedure: parsed.procedure, atLocal: parsed.at, days, nextRunAt: next, active: true })
      .onConflictDoUpdate({
        target: [routines.agentId, routines.title],
        set: { procedure: parsed.procedure, atLocal: parsed.at, days, nextRunAt: next, active: true, setUpBy: null },
      });
    const cadence = cadenceLabel(parsed.at, days);
    await recordActivity(ctx.db, { agentId: ctx.callerId, jobId: ctx.jobId, kind: "routine", subject: parsed.title, digest: `set: ${cadence}` });
    ctx.events.emit({ type: "schedules_changed", at: new Date().toISOString() });
    return ok({ title: parsed.title, cadence, next_run_at: next.toISOString() });
  },
});
