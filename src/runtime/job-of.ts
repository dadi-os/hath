/**
 * Which job a message, report, reminder or routine firing belongs to, decided by hath with no
 * model call. For a message that reaches an agent, in this order:
 *
 * 1. From the requester of one of its open jobs: that job.
 * 2. From an agent it asked in job J (the ask's own `job_id`): J. An ask is a message the agent
 *    sent that did not answer the sender's job.
 * 3. A helper report: the job its task was last steered in (`helper_steers`).
 * 4. A reminder, a wait timeout or an async result: the job it was made in (the caller passes it).
 * 5. A routine firing: a new job with no requester (`openRoutineJob`).
 * 6. Anything else: a new job whose requester is the sender.
 *
 * A reply to a message the agent sent before messages carried jobs belongs to no job, as a reply
 * never opened one. `messages.job_id` on a message between two agents is the sender's job.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { helperSteers, jobs, messages, type JobRow } from "../db/schema.js";
import { jobById, openJob } from "./jobs.js";

/** A message's job, whether this message opened it. */
export type ResolvedJob = { job: JobRow; isNew: boolean };

/**
 * resolveInbound is the job of message `message`, which reached agent `message.toAgentId` from
 * `message.fromAgentId` (null is Ankur), or null when it belongs to none. A new job is Ankur's
 * and due `answerByMinutes` after his message, or another agent's and due never.
 */
export async function resolveInbound(
  db: Db,
  message: { seq: number; fromAgentId: string | null; toAgentId: string },
  answerByMinutes: number,
  now: Date,
): Promise<ResolvedJob | null> {
  const agent = message.toAgentId;
  const sender = message.fromAgentId;
  const open = await openJob(db, sender, agent);
  if (open !== undefined) {
    if (open.state === "needs_input") {
      await db.update(jobs).set({ state: "open", questionSeq: null, updatedAt: now }).where(eq(jobs.id, open.id));
    }
    return { job: open, isNew: false };
  }
  if (sender !== null) {
    const [asked] = await db
      .select({ jobId: messages.jobId })
      .from(messages)
      .where(and(eq(messages.fromAgentId, agent), eq(messages.toAgentId, sender), eq(messages.kind, "message")))
      .orderBy(desc(messages.seq))
      .limit(1);
    if (asked !== undefined) {
      if (asked.jobId === null) {
        return null;
      }
      const job = await jobById(db, asked.jobId);
      if (job.requesterId !== sender) {
        return { job, isNew: false };
      }
    }
  }
  const [created] = await db
    .insert(jobs)
    .values({
      id: randomUUID(),
      requesterId: sender,
      agentId: agent,
      state: "open",
      openedSeq: message.seq,
      answerBy: sender === null ? new Date(now.getTime() + answerByMinutes * 60_000) : null,
    })
    .returning();
  if (created === undefined) {
    throw new Error("job insert returned no row");
  }
  return { job: created, isNew: true };
}

/**
 * outgoingJob is the job a message from `from` to `to` (null is Ankur) belongs to: the job `to`
 * gave `from` while it is open, else `current`, the job the sender's wake is on (null for none).
 */
export async function outgoingJob(db: Db, from: string, to: string | null, current: string | null): Promise<string | null> {
  if (to !== from) {
    const open = await openJob(db, to, from);
    if (open !== undefined) {
      return open.id;
    }
  }
  return current;
}

/** jobOfTask is the job helper task `task` was last steered in, or null when it was steered outside any job or never. */
export async function jobOfTask(db: Db, task: string): Promise<string | null> {
  const [row] = await db.select({ jobId: helperSteers.jobId }).from(helperSteers).where(eq(helperSteers.task, task));
  return row?.jobId ?? null;
}

/** noteSteer records that `agentId` steered `task` in `jobId` with `message`, replacing the task's earlier steer. */
export async function noteSteer(db: Db, task: string, agentId: string, jobId: string | null, message: string): Promise<void> {
  await db
    .insert(helperSteers)
    .values({ task, agentId, jobId, message })
    .onConflictDoUpdate({ target: helperSteers.task, set: { agentId, jobId, message, steeredAt: new Date() } });
}

/**
 * openRunJob opens a job of `agentId` at message `seq` with no requester of its own: the
 * agent itself is the requester, so nobody is waiting on an answer. `routineId` marks a
 * routine's run.
 */
export async function openRunJob(
  db: Db,
  args: { agentId: string; seq: number; routineId: string | null; requesterId: string },
): Promise<JobRow> {
  const [created] = await db
    .insert(jobs)
    .values({
      id: randomUUID(),
      requesterId: args.requesterId,
      agentId: args.agentId,
      state: "open",
      openedSeq: args.seq,
      routineId: args.routineId,
    })
    .returning();
  if (created === undefined) {
    throw new Error("job insert returned no row");
  }
  return created;
}
