/**
 * What an agent is waiting on: its job's pending items, recorded when a run ends with any
 * (see loop.ts). A watch is a row, so a restart keeps it: the scheduler's tick wakes the agent
 * with facts when one falls due, and the awaited result or message wakes it on its own
 * (deliver.ts takes the watch then). A watch is dropped when the agent next runs, since an
 * agent that woke for any reason is not waiting.
 */

import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentLogs, messages, watches, type WatchRow } from "../db/schema.js";
import type { NasClient } from "../nas/client.js";
import { parseTaskAddress } from "../tools/helper/tasks.js";
import type { DeliverDeps } from "./deliver.js";
import { pendingItems, pendingTargets } from "./pending.js";
import { rewake } from "./rewake.js";

/** The agent's watch, if it has one. */
export async function watchOf(db: Db, agentId: string): Promise<WatchRow | undefined> {
  const [row] = await db.select().from(watches).where(eq(watches.agentId, agentId));
  return row;
}

/** clearWatch drops the agent's watch. */
export async function clearWatch(db: Db, agentId: string): Promise<void> {
  await db.delete(watches).where(eq(watches.agentId, agentId));
}

/**
 * takeWatch drops the agent's watch when it is waiting on `target` (a task address or an
 * agent id), and says whether it was: that arrival is what the agent waited for.
 */
export async function takeWatch(db: Db, agentId: string, target: string): Promise<boolean> {
  const taken = await db
    .delete(watches)
    .where(and(eq(watches.agentId, agentId), sql`${target} = any(${watches.targets})`))
    .returning({ agentId: watches.agentId });
  return taken.length > 0;
}

/** recordPendingWatch records a watch on job `jobId`'s pending items for `minutes` when it has any. */
export async function recordPendingWatch(db: Db, nas: NasClient, agentId: string, jobId: string | null, minutes: number): Promise<void> {
  if (jobId === null) {
    return;
  }
  const targets = pendingTargets(await pendingItems(db, nas, jobId));
  if (targets.length > 0) {
    await recordWatch(db, agentId, jobId, targets, minutes);
  }
}

/** recordWatch records that `agentId` waits on `targets` for `minutes` in job `jobId` (null for none), replacing any wait it had, and returns when it falls due. */
export async function recordWatch(db: Db, agentId: string, jobId: string | null, targets: string[], minutes: number): Promise<Date> {
  const dueAt = new Date(Date.now() + minutes * 60_000);
  await db
    .insert(watches)
    .values({ agentId, targets, dueAt, jobId })
    .onConflictDoUpdate({ target: watches.agentId, set: { targets, since: new Date(), dueAt, jobId } });
  return dueAt;
}

/** What the facts of a due watch need: the database, Nas for task state, and a way to wake the agent. */
export type WatchDeps = {
  deliver: DeliverDeps;
  nas: NasClient;
};

/**
 * checkDueWatches wakes every agent whose watch has fallen due, with the facts of what it
 * waited on, and drops the watch. Run from the scheduler's tick.
 */
export async function checkDueWatches(deps: WatchDeps, now = new Date()): Promise<void> {
  const due = await deps.deliver.db.select().from(watches).where(lte(watches.dueAt, now));
  for (const watch of due) {
    const facts = await Promise.all(watch.targets.map((target) => factsAbout(deps, watch, target, now)));
    await clearWatch(deps.deliver.db, watch.agentId);
    const waited = minutesBetween(watch.since, now);
    await rewake(deps.deliver, watch.agentId, {
      content: `Your wait timed out after ${waited} minutes with nothing from what you waited on.\n${facts.map((fact) => `- ${fact}`).join("\n")}`,
      notice: "wait",
      wokenBy: "wait timeout",
      jobId: watch.jobId,
    });
  }
}

/** factsAbout is what is known of one thing an agent waited on. */
async function factsAbout(deps: WatchDeps, watch: WatchRow, target: string, now: Date): Promise<string> {
  const address = parseTaskAddress(target);
  if (address !== null) {
    try {
      const task = await deps.nas.getTask(address.kind, address.id);
      return `${target} is ${task.status}; it last did anything ${minutesBetween(new Date(task.last_activity), now)} minutes ago.`;
    } catch (err) {
      return `${target} could not be read: ${err instanceof Error ? err.message : String(err)}.`;
    }
  }
  const db = deps.deliver.db;
  const [lastLog] = await db
    .select({ at: agentLogs.createdAt })
    .from(agentLogs)
    .where(eq(agentLogs.agentId, target))
    .orderBy(desc(agentLogs.createdAt))
    .limit(1);
  const [lastMessage] = await db
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.fromAgentId, watch.agentId), eq(messages.toAgentId, target)))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const active = lastLog === undefined ? "it has never acted" : `it last acted ${minutesBetween(lastLog.at, now)} minutes ago`;
  if (lastMessage === undefined) {
    return `${target}: ${active}; you have not messaged it.`;
  }
  const ran = lastLog !== undefined && lastLog.at > lastMessage.at;
  return `${target}: ${active}; ${ran ? "it has run since" : "it has not run since"} you messaged it ${minutesBetween(lastMessage.at, now)} minutes ago.`;
}

/** Whole minutes from `from` to `to`. */
function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}
