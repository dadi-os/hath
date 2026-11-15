/** Stopping an agent's job: end its run, halt its helper tasks, mark the job stopped. */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { helperSteers, jobs } from "../db/schema.js";
import type { NasClient } from "../nas/client.js";
import { parseTaskAddress } from "../tools/helper/tasks.js";
import { recordActivity } from "./activity.js";
import type { Interrupts } from "./interrupts.js";
import { OPEN_STATES, openJob } from "./jobs.js";

export type StopDeps = {
  db: Db;
  nas: NasClient;
  interrupts: Interrupts;
  /** The job the agent's current wake is on, or null when it has no wake or none is on a job. */
  wakeJobId: (agentId: string) => string | null;
};

/** What a stop did. */
export type StopResult = {
  /** True when the agent's loop was running and was ended. */
  ended_run: boolean;
  /** The stopped job's number, or null when the agent had no open job. */
  job: number | null;
  /** The helper tasks halted, and any that could not be (never skipped silently). */
  stopped_tasks: string[];
  halt_failed: { task: string; error: string }[];
};

/**
 * stopAgent ends `agentId`'s running loop at once (the model call in flight is cancelled and no
 * further tool call runs), halts the helper tasks steered in its current job, and marks that job
 * stopped by `by`. The current job is the one its wake is on, else the open job Ankur gave it.
 * Reminders of a stopped job are dropped when they fire.
 */
export async function stopAgent(deps: StopDeps, agentId: string, by: string): Promise<StopResult> {
  const endedRun = deps.interrupts.stop(agentId);
  const wakeJob = deps.wakeJobId(agentId);
  const [onWake] = wakeJob === null ? [] : await deps.db.select().from(jobs).where(and(eq(jobs.id, wakeJob), inArray(jobs.state, [...OPEN_STATES])));
  const job = onWake ?? (await openJob(deps.db, null, agentId));
  if (job === undefined) {
    return { ended_run: endedRun, job: null, stopped_tasks: [], halt_failed: [] };
  }
  const now = new Date();
  await deps.db.update(jobs).set({ state: "stopped", stoppedAt: now, stoppedBy: by, updatedAt: now }).where(eq(jobs.id, job.id));
  const steered = await deps.db.select({ task: helperSteers.task }).from(helperSteers).where(eq(helperSteers.jobId, job.id));
  const results = await Promise.allSettled(
    steered.map(async ({ task }) => {
      const address = parseTaskAddress(task);
      if (address === null) {
        throw new Error(`${task} is not a task address`);
      }
      return deps.nas.haltTask(address.kind, address.id);
    }),
  );
  const stopped: string[] = [];
  const failed: { task: string; error: string }[] = [];
  results.forEach((result, index) => {
    const task = steered[index]!.task;
    if (result.status === "fulfilled") {
      stopped.push(task);
    } else {
      failed.push({ task, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    }
  });
  await recordActivity(deps.db, { agentId, jobId: job.id, kind: "stop", subject: `job #${job.openedSeq}`, digest: `stopped by ${by}` });
  return { ended_run: endedRun, job: job.openedSeq, stopped_tasks: stopped, halt_failed: failed };
}
