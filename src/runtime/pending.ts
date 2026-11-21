/** What a job is waiting on: asks an agent may still answer and helper tasks still working. */

import { and, eq, gte, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { messages, watches, wakes } from "../db/schema.js";
import type { NasClient } from "../nas/client.js";
import { jobById } from "./jobs.js";
import { jobLedger } from "./ledger.js";

/** The agents the job asked that may still answer, and the helper tasks steered in it that are working. */
export type PendingItems = { asks: string[]; tasks: string[] };

/**
 * mayStillAnswer is true while the agent asked in message `askSeq` can yet reply: it is running
 * now, it waits on something of its own, or it has not finished a run since the ask. An agent
 * that has run since, and is idle with nothing pending, has already decided not to answer, so
 * waiting on it again is waiting on nothing (the same rule as a helper task that is no longer working).
 */
async function mayStillAnswer(db: Db, agentId: string, askSeq: number): Promise<boolean> {
  const [ask] = await db.select({ at: messages.createdAt }).from(messages).where(eq(messages.seq, askSeq));
  if (ask === undefined) {
    return true;
  }
  const running = await db.select({ id: wakes.id }).from(wakes).where(and(eq(wakes.agentId, agentId), isNull(wakes.endedAt))).limit(1);
  const waiting = await db.select({ agentId: watches.agentId }).from(watches).where(eq(watches.agentId, agentId)).limit(1);
  const since = await db
    .select({ id: wakes.id })
    .from(wakes)
    .where(and(eq(wakes.agentId, agentId), isNotNull(wakes.endedAt), gte(wakes.startedAt, ask.at)))
    .limit(1);
  return running.length > 0 || waiting.length > 0 || since.length === 0;
}

/**
 * pendingItems reads job `jobId`'s ledger and, when the job steered helpers, their state in Nas;
 * a Nas that cannot be read is an error, not an empty answer.
 */
export async function pendingItems(db: Db, nas: NasClient, jobId: string): Promise<PendingItems> {
  const ledger = await jobLedger(db, await jobById(db, jobId));
  const unanswered = ledger.asks.filter((ask) => ask.answered_seq === null);
  const live = new Set<string>();
  for (const ask of unanswered) {
    if (await mayStillAnswer(db, ask.to, ask.seq)) {
      live.add(ask.to);
    }
  }
  const asks = [...new Set(unanswered.map((ask) => ask.to))].filter((to) => live.has(to));
  if (ledger.helpers.length === 0) {
    return { asks, tasks: [] };
  }
  const working = new Set((await nas.listTasks()).filter((task) => task.status === "working").map((task) => task.task));
  return { asks, tasks: ledger.helpers.filter((task) => working.has(task)) };
}

/** pendingTargets is every pending item as a watch target: agent ids, then task addresses. */
export function pendingTargets(pending: PendingItems): string[] {
  return [...pending.asks, ...pending.tasks];
}
