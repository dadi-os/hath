/**
 * The data migration from scheduled messages to routines and reminders, run by `migrate` after
 * the SQL migrations because it needs the box's time zone. A repeating row (a daily or weekly
 * interval) becomes a routine of its recipient, titled by the first line of its text; a row that
 * went to another agent keeps its author in `set_up_by`, for the one-time line of its first
 * firing. A one-shot row becomes a reminder of its recipient with the author on it, which opens
 * a job when it fires. Rows keep their next fire time. The table is copied to
 * `scheduled_messages_backup_20261114` and dropped.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { reminders, routines } from "./schema.js";
import type { Weekday } from "../types/domain.js";

/** A legacy row; its times are ISO strings, since the driver hands timestamps back as the database wrote them. */
type LegacyRow = {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  content: string;
  run_at: string;
  interval_minutes: number | null;
  created_at: string;
};

const DAILY_MINUTES = 1440;
const WEEKLY_MINUTES = 10080;
const TITLE_CHARS = 60;

/** The routine title a row's content gives: its first line, or its first 60 characters when that is longer. */
export function routineTitle(content: string): string {
  const first = content.split("\n").find((line) => line.trim() !== "")?.trim() ?? "Routine";
  return first.length <= TITLE_CHARS ? first : first.slice(0, TITLE_CHARS).trimEnd();
}

/** localParts is the wall-clock time (HH:MM) and weekday of `at` in `timeZone`. */
export function localParts(at: Date, timeZone: string): { time: string; weekday: Weekday } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return { time: `${part("hour")}:${part("minute")}`, weekday: part("weekday").toLowerCase().slice(0, 3) as Weekday };
}

/**
 * convertScheduledMessages converts and drops `scheduled_messages`, in one transaction, and says
 * how many routines and reminders it made; null when the table is already gone. A repeating row
 * whose interval is not a day or a week cannot be a routine, so it throws and nothing changes.
 */
export async function convertScheduledMessages(db: Db, timeZone: string): Promise<{ routines: number; reminders: number } | null> {
  const [present] = await db.execute<{ found: string | null }>(sql`select to_regclass('scheduled_messages') as found`);
  if (present?.found === null || present === undefined) {
    return null;
  }
  return db.transaction(async (tx) => {
    const rows = await tx.execute<LegacyRow>(
      sql`select id, from_agent_id, to_agent_id, content,
            to_char(run_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as run_at,
            interval_minutes,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
          from scheduled_messages order by created_at, id`,
    );
    const odd = rows.filter((row) => row.interval_minutes !== null && row.interval_minutes !== DAILY_MINUTES && row.interval_minutes !== WEEKLY_MINUTES);
    if (odd.length > 0) {
      throw new Error(
        `scheduled messages repeat on an interval a routine cannot hold (only daily or weekly): ${odd.map((row) => `${row.id} every ${row.interval_minutes} minutes`).join(", ")}; change or delete them before migrating`,
      );
    }
    const taken = new Map<string, Set<string>>();
    let routineCount = 0;
    let reminderCount = 0;
    for (const row of rows) {
      if (row.interval_minutes === null) {
        await tx.insert(reminders).values({
          id: row.id,
          agentId: row.to_agent_id,
          authorId: row.from_agent_id,
          note: row.content,
          runAt: new Date(row.run_at),
        });
        reminderCount += 1;
        continue;
      }
      const local = localParts(new Date(row.run_at), timeZone);
      const titles = taken.get(row.to_agent_id) ?? new Set<string>();
      taken.set(row.to_agent_id, titles);
      const base = routineTitle(row.content);
      let title = base;
      for (let n = 2; titles.has(title); n += 1) {
        title = `${base} (${n})`;
      }
      titles.add(title);
      await tx.insert(routines).values({
        id: randomUUID(),
        agentId: row.to_agent_id,
        title,
        procedure: row.content,
        atLocal: local.time,
        days: row.interval_minutes === WEEKLY_MINUTES ? [local.weekday] : null,
        nextRunAt: new Date(row.run_at),
        active: true,
        setUpBy: row.from_agent_id === row.to_agent_id ? null : row.from_agent_id,
        createdAt: new Date(row.created_at),
      });
      routineCount += 1;
    }
    await tx.execute(sql`create table scheduled_messages_backup_20261114 as select * from scheduled_messages`);
    await tx.execute(sql`drop table scheduled_messages`);
    return { routines: routineCount, reminders: reminderCount };
  });
}
