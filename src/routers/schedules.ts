/** Routine and reminder routes for the app: an agent's own duties and later steps, and hand cancels. */

import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { reminders, routines } from "../db/schema.js";
import { HathError } from "../errors.js";
import { requireAgent } from "../runtime/tools.js";
import { toReminderRecord, toRoutineRecord } from "../serialize.js";
import { idParam, parse, scheduleIdParam } from "./schemas.js";

/**
 * Register GET /agents/:id/routines (the agent's routines and reminders, next run first),
 * DELETE /routines/:id and DELETE /reminders/:id. Deleting acts as Ankur, so unlike the agent
 * tools it may remove any agent's routine; a routine is changed only by its owner.
 */
export async function registerSchedules(app: FastifyInstance): Promise<void> {
  app.get("/agents/:id/routines", async (request) => {
    const { id } = parse(idParam, request.params);
    await requireAgent(app.db, id);
    const routineRows = await app.db.select().from(routines).where(eq(routines.agentId, id)).orderBy(asc(routines.nextRunAt));
    const reminderRows = await app.db.select().from(reminders).where(eq(reminders.agentId, id)).orderBy(asc(reminders.runAt));
    return { routines: routineRows.map(toRoutineRecord), reminders: reminderRows.map(toReminderRecord) };
  });

  app.delete("/routines/:id", async (request) => {
    const { id } = parse(scheduleIdParam, request.params);
    const rows = await app.db.delete(routines).where(eq(routines.id, id)).returning({ id: routines.id });
    if (rows.length === 0) {
      throw new HathError(404, "not_found", `routine ${id} not found`);
    }
    app.runtime.events.emit({ type: "schedules_changed", at: new Date().toISOString() });
    return { cancelled: true, routine_id: id };
  });

  app.delete("/reminders/:id", async (request) => {
    const { id } = parse(scheduleIdParam, request.params);
    const rows = await app.db.delete(reminders).where(eq(reminders.id, id)).returning({ id: reminders.id });
    if (rows.length === 0) {
      throw new HathError(404, "not_found", `reminder ${id} not found`);
    }
    app.runtime.events.emit({ type: "schedules_changed", at: new Date().toISOString() });
    return { cancelled: true, reminder_id: id };
  });
}
