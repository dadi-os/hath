/**
 * Job state: which job is open on a line, how a job closes, and the cleanup of jobs a wake
 * touched but did nothing on. Which job a message belongs to is job-of.ts; what a job has done
 * is ledger.ts.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobs, type JobRow } from "../db/schema.js";
import type { NasClient } from "../nas/client.js";
import type { MessageStatus } from "../types/domain.js";
import { pendingItems } from "./pending.js";
import type { TranscriptEntry } from "./transcript.js";
import type { Wake } from "./wake.js";

/** Job states in which the work is still the agent's. */
export const OPEN_STATES = ["open", "needs_input"] as const;

/** requesterIs matches `jobs.requester_id` to `requester`, null being Ankur. */
function requesterIs(requester: string | null) {
  return requester === null ? isNull(jobs.requesterId) : eq(jobs.requesterId, requester);
}

/** openJob is the job still open on `requester`'s line to `agent`, if there is one. A requester is never the agent itself. */
export async function openJob(db: Db, requester: string | null, agent: string): Promise<JobRow | undefined> {
  const [row] = await db
    .select()
    .from(jobs)
    .where(and(requesterIs(requester), eq(jobs.agentId, agent), inArray(jobs.state, [...OPEN_STATES])));
  return row;
}

/** jobById is the job `id` names; throws when there is none, since every id comes from a stamped row. */
export async function jobById(db: Db, id: string): Promise<JobRow> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (row === undefined) {
    throw new Error(`job ${id} does not exist`);
  }
  return row;
}

/** hasRequester is true when someone other than the agent itself gave the job: Ankur or another agent. */
export function hasRequester(job: Pick<JobRow, "requesterId" | "agentId">): boolean {
  return job.requesterId !== job.agentId;
}

/**
 * blockOpenJob closes `requester`'s open job with `agent` as blocked at `seq`, for a
 * runtime report that already told the requester the work stopped (a failed run), so
 * the wake's end does not report the same job a second time as unfinished.
 */
export async function blockOpenJob(db: Db, requester: string | null, agent: string, seq: number): Promise<void> {
  await db
    .update(jobs)
    .set({ state: "blocked", closedSeq: seq, updatedAt: new Date() })
    .where(and(requesterIs(requester), eq(jobs.agentId, agent), eq(jobs.state, "open")));
}

/**
 * recordStatus applies the status of an agent's message `seq` to job `job` when the message is
 * to the job's requester: done or blocked closes the job, needs_input parks it on that question,
 * and a message with no status is the answer, so it closes the job as done. A message to anyone
 * else, or one hath sent for the agent (a pickup), leaves the job as it is.
 */
export async function recordStatus(
  db: Db,
  job: JobRow,
  message: { seq: number; toAgentId: string | null; status: MessageStatus | null; sentBy?: "hath" },
): Promise<void> {
  if (message.sentBy !== undefined || message.toAgentId !== job.requesterId || !(OPEN_STATES as readonly string[]).includes(job.state)) {
    return;
  }
  const change =
    message.status === "needs_input"
      ? { state: "needs_input" as const, questionSeq: message.seq }
      : { state: message.status ?? ("done" as const), closedSeq: message.seq };
  await db.update(jobs).set({ ...change, updatedAt: new Date() }).where(eq(jobs.id, job.id));
}

/**
 * settleWakeJobs closes, when an agent's wake ends, each job opened during that wake (by a
 * message among `lines`, the agent's transcript rows since its previous wake) that the wake
 * did nothing on: no step but a yield and no message back, so it was a message that needed
 * no work (noop). A job with an answer-by time stays open through a yield: the timer is the
 * backstop for an answer Ankur is owed. The wake's own job, when it has no requester (a routine's), closes as done
 * when the run ends with nothing pending. Every other job stays open until the agent reports
 * on it: hath never decides from outside that a job stalled, since an agent that yielded may be
 * waiting on a reply that wakes it (health-specialist's Dr. Zubair job was closed as
 * "unfinished" on 2026-10-19 while it waited on efficiency-specialist).
 */
export async function settleWakeJobs(db: Db, nas: NasClient, lines: TranscriptEntry[], agentId: string, wake: Wake): Promise<void> {
  if (wake.jobId !== null) {
    const job = await jobById(db, wake.jobId);
    if (job.state === "open" && !hasRequester(job)) {
      const pending = await pendingItems(db, nas, job.id);
      if (pending.asks.length + pending.tasks.length === 0) {
        await db.update(jobs).set({ state: "done", closedSeq: lines.at(-1)?.seq ?? job.openedSeq, updatedAt: new Date() }).where(eq(jobs.id, job.id));
      }
    }
  }
  const firstSeq = lines[0]?.seq;
  if ((wake.reasoned() && !wake.yieldedOnly()) || firstSeq === undefined) {
    return;
  }
  const open = await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.state, "open")));
  for (const job of open.filter((row) => row.openedSeq >= firstSeq && hasRequester(row) && !(wake.reasoned() && row.answerBy !== null))) {
    const onLine = lines.filter(
      (row) =>
        row.kind !== "notice" &&
        ((row.fromAgentId === job.requesterId && row.toAgentId === agentId) ||
          (row.fromAgentId === agentId && row.toAgentId === job.requesterId)),
    );
    if (onLine.length > 0 && !onLine.some((row) => row.fromAgentId === agentId)) {
      await db.update(jobs).set({ state: "noop", updatedAt: new Date() }).where(eq(jobs.id, job.id));
    }
  }
}
