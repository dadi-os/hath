/** Scheduled-message ticker: advance due rows, then deliver at-most-once. */

import { addDays, addMinutes } from "date-fns";
import { asc, eq, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { WakeOrigin } from "../types/domain.js";
import { agents, scheduledMessages, type ScheduledMessageRow } from "../db/schema.js";
import { deliverAgentMessage } from "./deliver.js";
import type { EventBus } from "./events.js";
import type { WakeActivity } from "./wake-activity.js";
import { SWEEP_INTERVAL_MS } from "./retention.js";
import type { TranscriptStore } from "./transcript.js";
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

/** Advance `runAt` by `intervalMinutes`, preserving the box's wall time (`TZ`) across DST for day multiples. */
export function advanceRunAt(runAt: Date, intervalMinutes: number): Date {
  if (intervalMinutes % 1440 === 0) {
    const days = intervalMinutes / 1440;
    return addDays(runAt, days);
  }
  return addMinutes(runAt, intervalMinutes);
}

type FiredRow = ScheduledMessageRow & { firedAt: Date };

/** Polls every `tickSeconds`: sweeps the file caches once a day, wakes the work lane of each agent whose wait is due, delivers due scheduled messages into transcripts, waking each recipient's process lane, and sends hath's pickups when they are on. */
export function createScheduler(opts: {
  db: Db;
  transcript: TranscriptStore;
  events: EventBus;
  enqueueProcess: (agentId: string, reason?: string, origin?: WakeOrigin) => string;
  enqueueWork: (agentId: string, reason?: string, origin?: WakeOrigin) => string;
  /** Told of each message a firing delivers, so the woken wake reports its count. */
  wakeActivity: WakeActivity;
  log: SchedulerLog;
  tickSeconds: number;
  /** What a due wait needs (see watches.ts). */
  watches: WatchDeps;
  /** The cache retention sweep (see retention.ts), run on the first tick and then daily. */
  sweep: (now: Date) => Promise<void>;
  /** hath's pickups for Ankur's overdue jobs (see pickups.ts), run every tick; null when `runtime.hath_pickups` is off. */
  pickups: ((now: Date) => Promise<void>) | null;
}): Scheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let lastSweep: Date | undefined;

  async function advanceDue(now: Date): Promise<FiredRow[]> {
    return opts.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(scheduledMessages)
        .where(lte(scheduledMessages.runAt, now))
        .orderBy(asc(scheduledMessages.runAt))
        .for("update");

      const fired: FiredRow[] = [];
      for (const row of due) {
        const firedAt = row.runAt;
        if (row.intervalMinutes === null) {
          await tx.delete(scheduledMessages).where(eq(scheduledMessages.id, row.id));
          fired.push({ ...row, firedAt });
          continue;
        }

        let next = row.runAt;
        let advances = 0;
        while (next.getTime() <= now.getTime()) {
          next = advanceRunAt(next, row.intervalMinutes);
          advances += 1;
        }
        await tx
          .update(scheduledMessages)
          .set({ runAt: next })
          .where(eq(scheduledMessages.id, row.id));

        const latenessMs = now.getTime() - firedAt.getTime();
        if (advances > 1 || latenessMs > opts.tickSeconds * 2 * 1000) {
          opts.log.warn(
            {
              code: "schedule_late",
              schedule_id: row.id,
              fired_at: firedAt.toISOString(),
              lateness_ms: latenessMs,
              skipped: advances - 1,
            },
            "scheduled message caught up late",
          );
        }
        fired.push({ ...row, runAt: next, firedAt });
      }
      return fired;
    });
  }

  async function deliverFired(row: FiredRow): Promise<void> {
    const targets = await opts.db.select().from(agents).where(eq(agents.id, row.toAgentId));
    const target = targets[0];
    if (!target) {
      opts.log.error(
        {
          code: "schedule_target_unavailable",
          schedule_id: row.id,
          to_agent_id: row.toAgentId,
          from_agent_id: row.fromAgentId,
          reason: "missing",
        },
        "scheduled message target missing",
      );
      return;
    }
    if (!target.active) {
      opts.log.error(
        {
          code: "schedule_target_unavailable",
          schedule_id: row.id,
          to_agent_id: row.toAgentId,
          from_agent_id: row.fromAgentId,
          reason: "retired",
        },
        "scheduled message target retired",
      );
      return;
    }
    await deliverAgentMessage(
      {
        db: opts.db,
        transcript: opts.transcript,
        events: opts.events,
        enqueueProcess: opts.enqueueProcess,
        enqueueWork: opts.enqueueWork,
        wakeActivity: opts.wakeActivity,
      },
      {
        fromAgentId: row.fromAgentId,
        toAgentId: row.toAgentId,
        content: row.content,
        scheduleId: row.id,
        ...(row.intervalMinutes !== null ? { routine: row.id } : {}),
        scheduled: true,
      },
    );
  }

  async function tick(now = new Date()): Promise<void> {
    if (ticking) {
      return;
    }
    ticking = true;
    try {
      await checkDueWatches(opts.watches, now);
      const fired = await advanceDue(now);
      if (fired.length > 0) {
        opts.events.emit({ type: "schedules_changed", at: new Date().toISOString() });
      }
      for (const row of fired) {
        await deliverFired(row);
      }
    } catch (err) {
      opts.log.error({ code: "schedule_tick_failed", err }, "schedule tick failed");
    }
    if (opts.pickups !== null) {
      try {
        await opts.pickups(now);
      } catch (err) {
        opts.log.error({ code: "pickups_failed", err }, "pickup pass failed");
      }
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
