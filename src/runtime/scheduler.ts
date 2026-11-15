/**
 * The ticker: wakes the agents whose waits are due, tells agents their answer time passed, fires due routines
 * and reminders, sends hath's pickups and sweeps the file caches. A routine firing opens a job of its own with no
 * requester; a reminder fires into its job.
 */

import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, jobs, reminders, routines, type ReminderRow, type RoutineRow } from "../db/schema.js";
import type { Weekday, WakeOrigin } from "../types/domain.js";
import { recordActivity } from "./activity.js";
import { deliverAgentMessage, type DeliverDeps } from "./deliver.js";
import type { EventBus } from "./events.js";
import { openJob, OPEN_STATES } from "./jobs.js";
import { openRunJob } from "./job-of.js";
import { nextRunAt } from "./routines.js";
import type { WakeActivity } from "./wake-activity.js";
import { SWEEP_INTERVAL_MS } from "./retention.js";
import type { TranscriptStore } from "./transcript.js";
import { checkAnswerBy } from "./answer-by.js";
import { checkDueWatches, type WatchDeps } from "./watches.js";

type SchedulerLog = {
  error: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type Scheduler = {
  start(): void;
  stop(): void;
  /** One tick pass. Optional `now` is for tests (DST / catch-up). */
  tick(now?: Date): Promise<void>;
};

type FiredRoutine = { row: RoutineRow; firedAt: Date };

/**
 * Polls every `tickSeconds`: sweeps the file caches once a day, wakes each agent
 * whose wait is due, tells each whose Ankur job is past its answer time, fires due routines and
 * reminders into their owners' jobs, and sends hath's pickups.
 */
export function createScheduler(opts: {
  db: Db;
  transcript: TranscriptStore;
  events: EventBus;
  enqueue: (agentId: string, reason?: string, origin?: WakeOrigin) => string;
  /** Cancels the model call of a running loop (see engine.ts). */
  preempt: (agentId: string, jobId: string) => void;
  /** Told of each message a firing delivers, so the woken wake reports its count. */
  wakeActivity: WakeActivity;
  /** `runtime.answer_by_minutes`. */
  answerByMinutes: number;
  log: SchedulerLog;
  tickSeconds: number;
  /** What a due wait needs (see watches.ts). */
  watches: WatchDeps;
  /** The cache retention sweep (see retention.ts), run on the first tick and then daily. */
  sweep: (now: Date) => Promise<void>;
  /** hath's pickups for Ankur's overdue jobs (see pickups.ts), run every tick. */
  pickups: (now: Date) => Promise<void>;
}): Scheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let lastSweep: Date | undefined;
  const deliver: DeliverDeps = {
    db: opts.db,
    transcript: opts.transcript,
    events: opts.events,
    enqueue: opts.enqueue,
    preempt: opts.preempt,
    wakeActivity: opts.wakeActivity,
    answerByMinutes: opts.answerByMinutes,
  };

  /** advanceDueRoutines moves every due routine to its next run and returns the ones that fired. A routine missed while hath was down fires once. */
  async function advanceDueRoutines(now: Date): Promise<FiredRoutine[]> {
    return opts.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(routines)
        .where(and(eq(routines.active, true), lte(routines.nextRunAt, now)))
        .orderBy(asc(routines.nextRunAt))
        .for("update");
      const fired: FiredRoutine[] = [];
      for (const row of due) {
        const next = nextRunAt(row.atLocal, row.days as Weekday[] | null, now);
        await tx.update(routines).set({ nextRunAt: next, lastRunAt: row.nextRunAt }).where(eq(routines.id, row.id));
        const latenessMs = now.getTime() - row.nextRunAt.getTime();
        if (latenessMs > opts.tickSeconds * 2 * 1000) {
          opts.log.warn(
            { code: "schedule_late", routine_id: row.id, fired_at: row.nextRunAt.toISOString(), lateness_ms: latenessMs },
            "routine caught up late",
          );
        }
        fired.push({ row, firedAt: row.nextRunAt });
      }
      return fired;
    });
  }

  /** agentIsActive is true when `agentId` exists and is not retired; a firing for any other is logged and dropped. */
  async function agentIsActive(agentId: string, what: Record<string, string>): Promise<boolean> {
    const [target] = await opts.db.select().from(agents).where(eq(agents.id, agentId));
    if (target === undefined || !target.active) {
      opts.log.error({ code: "schedule_target_unavailable", agent_id: agentId, reason: target === undefined ? "missing" : "retired", ...what }, "schedule target unavailable");
      return false;
    }
    return true;
  }

  /**
   * fireRoutine opens a job for one firing of `row`: its previous run's job is done, the firing
   * is a notice of the agent to itself that wakes it, and the job has no requester.
   * A routine set up for its owner by another agent says so the first time, then clears that.
   */
  async function fireRoutine({ row, firedAt }: FiredRoutine): Promise<void> {
    if (!(await agentIsActive(row.agentId, { routine_id: row.id }))) {
      return;
    }
    if (row.lastJobId !== null) {
      await opts.db
        .update(jobs)
        .set({ state: "done", updatedAt: new Date() })
        .where(and(eq(jobs.id, row.lastJobId), inArray(jobs.state, [...OPEN_STATES])));
    }
    const setUp =
      row.setUpBy === null || row.setUpBy === row.agentId
        ? ""
        : `\nThis routine was set up for you by ${row.setUpBy}; change it with set_routine if it should be different.`;
    let jobId = "";
    await deliverAgentMessage(deliver, {
      fromAgentId: row.agentId,
      toAgentId: row.agentId,
      content: `Your routine "${row.title}" fired at ${firedAt.toISOString()}.${setUp}`,
      notice: "routine",
      wokenBy: `your routine "${row.title}"`,
      scheduleId: row.id,
      opens: async (message) => {
        jobId = (await openRunJob(opts.db, { agentId: row.agentId, seq: message.seq, routineId: row.id, requesterId: row.agentId })).id;
        return jobId;
      },
    });
    await opts.db.update(routines).set({ lastJobId: jobId, setUpBy: null }).where(eq(routines.id, row.id));
    await recordActivity(opts.db, { agentId: row.agentId, jobId, kind: "routine", subject: row.title, digest: "ran" });
  }

  /** fireDueReminders fires and deletes every due reminder, at most once. */
  async function fireDueReminders(now: Date): Promise<ReminderRow[]> {
    return opts.db.transaction(async (tx) => {
      const due = await tx.select().from(reminders).where(lte(reminders.runAt, now)).orderBy(asc(reminders.runAt)).for("update");
      if (due.length > 0) {
        await tx.delete(reminders).where(inArray(reminders.id, due.map((row) => row.id)));
      }
      return due;
    });
  }

  /**
   * fireReminder wakes the agent in the reminder's job, which a done or blocked job returns to
   * open, with the note it left. A stopped job's reminder is dropped. A reminder with no job (made
   * from a one-shot scheduled message) opens one whose requester is its author, or no one when
   * the agent set it itself; an author with a job open on the agent has the reminder join it.
   */
  async function fireReminder(row: ReminderRow): Promise<void> {
    if (!(await agentIsActive(row.agentId, { reminder_id: row.id }))) {
      return;
    }
    let target = row.jobId === null ? undefined : (await opts.db.select().from(jobs).where(eq(jobs.id, row.jobId)))[0];
    if (target?.state === "stopped") {
      opts.log.info({ code: "reminder_job_stopped", reminder_id: row.id, job_id: target.id }, "reminder dropped: its job was stopped");
      return;
    }
    if (target !== undefined && !(OPEN_STATES as readonly string[]).includes(target.state)) {
      await opts.db.update(jobs).set({ state: "open", closedSeq: null, updatedAt: new Date() }).where(eq(jobs.id, target.id));
    }
    const requester = row.authorId ?? row.agentId;
    if (target === undefined && row.authorId !== null && row.authorId !== row.agentId) {
      target = await openJob(opts.db, row.authorId, row.agentId);
    }
    await deliverAgentMessage(deliver, {
      fromAgentId: row.agentId,
      toAgentId: row.agentId,
      content: `[Reminder] ${row.note}`,
      notice: "reminder",
      wokenBy: "your reminder",
      scheduleId: row.id,
      ...(target !== undefined
        ? { jobId: target.id }
        : {
            opens: async (message) =>
              (await openRunJob(opts.db, { agentId: row.agentId, seq: message.seq, routineId: null, requesterId: requester })).id,
          }),
    });
    await recordActivity(opts.db, { agentId: row.agentId, jobId: target?.id ?? null, kind: "reminder", subject: row.id, digest: `fired: ${row.note}` });
  }

  async function tick(now = new Date()): Promise<void> {
    if (ticking) {
      return;
    }
    ticking = true;
    try {
      await checkDueWatches(opts.watches, now);
      await checkAnswerBy({ deliver, nas: opts.watches.nas }, now);
      const firedRoutines = await advanceDueRoutines(now);
      const firedReminders = await fireDueReminders(now);
      if (firedRoutines.length + firedReminders.length > 0) {
        opts.events.emit({ type: "schedules_changed", at: new Date().toISOString() });
      }
      for (const fired of firedRoutines) {
        await fireRoutine(fired);
      }
      for (const row of firedReminders) {
        await fireReminder(row);
      }
    } catch (err) {
      opts.log.error({ code: "schedule_tick_failed", err }, "schedule tick failed");
    }
    try {
      await opts.pickups(now);
    } catch (err) {
      opts.log.error({ code: "pickups_failed", err }, "pickup pass failed");
    }
    try {
      if (lastSweep === undefined || now.getTime() - lastSweep.getTime() >= SWEEP_INTERVAL_MS) {
        lastSweep = now;
        await opts.sweep(now);
      }
    } catch (err) {
      opts.log.error({ code: "cache_sweep_failed", err }, "cache sweep failed");
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        void tick();
      }, opts.tickSeconds * 1000);
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    tick,
  };
}
