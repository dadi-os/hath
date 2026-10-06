/** Scheduled-message ticker: advance due rows, then deliver at-most-once. */

import { addDays, addMinutes } from "date-fns";
import { asc, eq, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, scheduledMessages, type ScheduledMessageRow } from "../db/schema.js";
import { deliverAgentMessage } from "./deliver.js";
import type { EventBus } from "./events.js";
import type { TranscriptStore } from "./transcript.js";

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

/** Polls scheduled messages every `tickSeconds`, delivers the due ones into transcripts, and wakes each recipient's conversation lane. */
export function createScheduler(opts: {
  db: Db;
  transcript: TranscriptStore;
  events: EventBus;
  enqueueConversation: (agentId: string) => void;
  log: SchedulerLog;
  tickSeconds: number;
}): Scheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

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
        enqueueConversation: opts.enqueueConversation,
      },
      {
        fromAgentId: row.fromAgentId,
        toAgentId: row.toAgentId,
        content: row.content,
        extraPayload: { schedule_id: row.id },
      },
    );
  }

  async function tick(now = new Date()): Promise<void> {
    if (ticking) {
      return;
    }
    ticking = true;
    try {
      const fired = await advanceDue(now);
      for (const row of fired) {
        await deliverFired(row);
      }
    } catch (err) {
      opts.log.error({ code: "schedule_tick_failed", err }, "schedule tick failed");
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
