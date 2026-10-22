/** Schedule routes for the app: an agent's scheduled messages, and hand edits and cancels. */

import { asc, eq, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { scheduledMessages } from "../db/schema.js";
import { HathError } from "../errors.js";
import { requireAgent } from "../runtime/tools.js";
import { toScheduledMessageRecord } from "../serialize.js";
import { idParam, parse, patchScheduleBody, scheduleIdParam } from "./schemas.js";

/**
 * Register GET /agents/:id/schedules (every schedule the agent sends or receives, next
 * run first), PATCH /schedules/:id and DELETE /schedules/:id. These act as Ankur, so
 * unlike the agent tools they may change any schedule, not only one the caller created.
 */
export async function registerSchedules(app: FastifyInstance): Promise<void> {
  app.get("/agents/:id/schedules", async (request) => {
    const { id } = parse(idParam, request.params);
    await requireAgent(app.db, id);
    const rows = await app.db
      .select()
      .from(scheduledMessages)
      .where(or(eq(scheduledMessages.fromAgentId, id), eq(scheduledMessages.toAgentId, id)))
      .orderBy(asc(scheduledMessages.runAt));
    return { schedules: rows.map(toScheduledMessageRecord) };
  });

  app.patch("/schedules/:id", async (request) => {
    const { id } = parse(scheduleIdParam, request.params);
    const body = parse(patchScheduleBody, request.body);
    if (body.run_at !== undefined && !(new Date(body.run_at).getTime() > Date.now())) {
      throw new HathError(422, "invalid_request", "run_at must be in the future");
    }
    const rows = await app.db
      .update(scheduledMessages)
      .set({
        ...(body.run_at !== undefined ? { runAt: new Date(body.run_at) } : {}),
        ...(body.interval_minutes !== undefined ? { intervalMinutes: body.interval_minutes } : {}),
        ...(body.content !== undefined ? { content: body.content } : {}),
      })
      .where(eq(scheduledMessages.id, id))
      .returning();
    const row = rows[0];
    if (!row) {
      throw new HathError(404, "not_found", `schedule ${id} not found`);
    }
    app.runtime.events.emit({ type: "schedules_changed", at: new Date().toISOString() });
    return toScheduledMessageRecord(row);
  });

  app.delete("/schedules/:id", async (request) => {
    const { id } = parse(scheduleIdParam, request.params);
    const rows = await app.db
      .delete(scheduledMessages)
      .where(eq(scheduledMessages.id, id))
      .returning({ id: scheduledMessages.id });
    if (rows.length === 0) {
      throw new HathError(404, "not_found", `schedule ${id} not found`);
    }
    app.runtime.events.emit({ type: "schedules_changed", at: new Date().toISOString() });
    return { cancelled: true, schedule_id: id };
  });
}
