/**
 * Jobs: the tracking behind the UI and the yield reminder. A job is the open work on one
 * line: a requester (null for Ankur) that messaged the agent before the agent ever
 * messaged it. A message back on that line may carry a status, which records the job's
 * progress; nothing refuses a send for its status or its absence.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobs, messages, type JobRow } from "../db/schema.js";
import type { TranscriptEntry } from "./transcript.js";

/** Job states in which the work is still the agent's. */
const OPEN_STATES = ["open", "needs_input"] as const;

/** requesterIs matches `jobs.requester_id` to `requester`, null being Ankur. */
function requesterIs(requester: string | null) {
  return requester === null ? isNull(jobs.requesterId) : eq(jobs.requesterId, requester);
}

/**
 * opensLine is true when `requester` opened the line to `agent`: its first message to
 * the agent came before the agent's first to it. Hath's notices never count,
 * as in currentRequester.
 */
export async function opensLine(db: Db, requester: string | null, agent: string): Promise<boolean> {
  const [row] = await db.execute<{ first_in: string | null; first_out: string | null }>(sql`
    select
      (select min(seq) from ${messages}
        where from_agent_id is not distinct from ${requester} and to_agent_id = ${agent}
          and kind = 'message') as first_in,
      (select min(seq) from ${messages}
        where from_agent_id = ${agent} and to_agent_id is not distinct from ${requester}
          and kind = 'message') as first_out
  `);
  if (!row) {
    throw new Error("line query returned no row");
  }
  return row.first_in !== null && (row.first_out === null || Number(row.first_in) < Number(row.first_out));
}

/** openJob is the job still open on `requester`'s line to `agent`, if there is one. */
export async function openJob(db: Db, requester: string | null, agent: string): Promise<JobRow | undefined> {
  const [row] = await db
    .select()
    .from(jobs)
    .where(and(requesterIs(requester), eq(jobs.agentId, agent), inArray(jobs.state, [...OPEN_STATES])));
  return row;
}

/**
 * blockOpenJob closes `requester`'s open job with `agent` as blocked at `seq`, for a
 * runtime report that already told the requester the work stopped (a failed lane), so
 * the wake's end does not report the same job a second time as unfinished.
 */
export async function blockOpenJob(db: Db, requester: string | null, agent: string, seq: number): Promise<void> {
  await db
    .update(jobs)
    .set({ state: "blocked", closedSeq: seq, updatedAt: new Date() })
    .where(and(requesterIs(requester), eq(jobs.agentId, agent), eq(jobs.state, "open")));
}

/**
 * recordDelivery keeps jobs in step with one delivered message. A requester's message on
 * its line opens a job, or joins the open one and answers the agent's open question.
 * An agent's status on a message to whoever gave it a job records its progress update,
 * its question, or the job's close. Hath's notices, an agent's notes to
 * itself, and scheduled triggers (a routine's clock, not a request) never touch a job.
 */
export async function recordDelivery(db: Db, row: TranscriptEntry, scheduled: boolean): Promise<void> {
  if (scheduled || row.fromAgentId === row.toAgentId || row.kind === "notice") {
    return;
  }
  if (row.toAgentId !== null && (await opensLine(db, row.fromAgentId, row.toAgentId))) {
    const job = await openJob(db, row.fromAgentId, row.toAgentId);
    if (job === undefined) {
      await db
        .insert(jobs)
        .values({ id: randomUUID(), requesterId: row.fromAgentId, agentId: row.toAgentId, state: "open", openedSeq: row.seq })
        .onConflictDoNothing();
    } else if (job.state === "needs_input") {
      await db.update(jobs).set({ state: "open", questionSeq: null, updatedAt: new Date() }).where(eq(jobs.id, job.id));
    }
    return;
  }
  if (row.fromAgentId === null || row.status === null) {
    return;
  }
  const job = await openJob(db, row.toAgentId, row.fromAgentId);
  if (job === undefined) {
    return;
  }
  const change =
    row.status === "running"
      ? { progressSeq: row.seq }
      : row.status === "needs_input"
        ? { state: "needs_input" as const, questionSeq: row.seq }
        : { state: row.status, closedSeq: row.seq };
  await db.update(jobs).set({ ...change, updatedAt: new Date() }).where(eq(jobs.id, job.id));
}

/**
 * settleWakeJobs closes, when an agent's wake ends, each job opened during that wake (by a
 * message among `lines`, the agent's transcript rows since its previous wake) that the wake
 * did nothing on: no work-lane step and no message back, so it was a message that needed
 * no work (noop). Every other job stays open until the agent reports on it: hath
 * never decides from outside that a job stalled, since an agent that yielded may be
 * waiting on a reply that wakes it (health-specialist's Dr. Zubair job was closed as
 * "unfinished" on 2026-10-19 while it waited on efficiency-specialist).
 */
export async function settleWakeJobs(db: Db, lines: TranscriptEntry[], agentId: string, reasoned: boolean): Promise<void> {
  const firstSeq = lines[0]?.seq;
  if (reasoned || firstSeq === undefined) {
    return;
  }
  const open = await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.state, "open")));
  for (const job of open.filter((row) => row.openedSeq >= firstSeq)) {
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
