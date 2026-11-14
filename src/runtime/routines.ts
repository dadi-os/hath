/**
 * Routines: an agent's own standing duties. A routine has an owner, a procedure, a local time
 * of day and weekdays, and no recipient, so it cannot arrive from anyone else. This module is
 * its cadence and the block a firing shows; the tools are in tools/hath and the firing is the
 * scheduler's.
 */

import { format } from "date-fns";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentActivity, jobs, type RoutineRow } from "../db/schema.js";
import type { Weekday } from "../types/domain.js";
import { localTime } from "./activity.js";

const WEEKDAY_OF_INDEX: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const WEEKDAY_NAME: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/**
 * nextRunAt is the first time after `after` that is `at` (HH:MM) by the box's wall clock on a
 * day in `days` (every day when null). It builds each candidate from local date parts, so a
 * daylight-saving change keeps the wall time.
 */
export function nextRunAt(at: string, days: readonly Weekday[] | null, after: Date): Date {
  const [hours, minutes] = at.split(":").map(Number) as [number, number];
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset, hours, minutes, 0, 0);
    if (candidate.getTime() > after.getTime() && (days === null || days.includes(WEEKDAY_OF_INDEX[candidate.getDay()]!))) {
      return candidate;
    }
  }
  throw new Error(`no time after ${after.toISOString()} is ${at} on ${days?.join(",")}`);
}

/** cadenceLabel is a routine's cadence as the agent reads it: "daily 7:00 AM" or "Mon, Wed 9:30 PM". */
export function cadenceLabel(at: string, days: readonly Weekday[] | null): string {
  const [hours, minutes] = at.split(":").map(Number) as [number, number];
  const time = format(new Date(2000, 0, 1, hours, minutes), "h:mm a");
  return `${days === null ? "daily" : days.map((day) => WEEKDAY_NAME[day]).join(", ")} ${time}`;
}

/** The stored and sent counts of one job, from the activity record. */
async function runCounts(db: Db, agentId: string, jobId: string): Promise<{ stored: number; sent: number }> {
  const rows = await db.execute<{ kind: string; n: number }>(sql`
    select kind, count(*)::int as n from ${agentActivity}
    where agent_id = ${agentId} and job_id = ${jobId} and kind in ('store', 'send')
    group by kind
  `);
  return { stored: rows.find((row) => row.kind === "store")?.n ?? 0, sent: rows.find((row) => row.kind === "send")?.n ?? 0 };
}

/**
 * routineBlock is the `[Routine]` block of a routine's wake: its title, that it is the agent's
 * own, its cadence, how its last run before `currentJobId` went (what it stored and sent), and
 * the procedure as the agent wrote it.
 */
export async function routineBlock(db: Db, routine: RoutineRow, currentJobId: string): Promise<string> {
  const [previous] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.routineId, routine.id), ne(jobs.id, currentJobId)))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  const last =
    previous === undefined
      ? "first run"
      : await runCounts(db, routine.agentId, previous.id).then(
          (counts) => `last run ${localTime(previous.createdAt)} (stored ${counts.stored}, sent ${counts.sent})`,
        );
  return [`[Routine "${routine.title}"] yours · ${cadenceLabel(routine.atLocal, routine.days as Weekday[] | null)} · ${last}`, routine.procedure].join("\n");
}
