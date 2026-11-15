/** What a job is waiting on: asks no one has answered and helper tasks still working. */

import type { Db } from "../db/client.js";
import type { NasClient } from "../nas/client.js";
import { jobById } from "./jobs.js";
import { jobLedger } from "./ledger.js";

/** The agents the job asked that have not answered, and the helper tasks steered in it that are working. */
export type PendingItems = { asks: string[]; tasks: string[] };

/**
 * pendingItems reads job `jobId`'s ledger and, when the job steered helpers, their state in Nas;
 * a Nas that cannot be read is an error, not an empty answer.
 */
export async function pendingItems(db: Db, nas: NasClient, jobId: string): Promise<PendingItems> {
  const ledger = await jobLedger(db, await jobById(db, jobId));
  const asks = [...new Set(ledger.asks.filter((ask) => ask.answered_seq === null).map((ask) => ask.to))];
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
