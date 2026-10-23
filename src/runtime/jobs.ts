/**
 * Jobs and the report gates every agent is held to. A job is the open work on one
 * line: a requester (null for Ankur) that messaged the agent before the agent ever
 * messaged it. The agent's messages back on that line carry a status. The gates are
 * plain rules over these rows, the same for managers, specialists, workers, bots, and
 * Ankur as a requester.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobs, messages, type JobRow } from "../db/schema.js";
import type { MessageStatus } from "../types/domain.js";
import type { TranscriptEntry } from "./transcript.js";

/** What a message's status input tells the model, shared by dispatch_message and forward_attachment. */
export const STATUS_DESCRIPTION =
  "Required on a message to whoever gave you a job that is still open: running for your one progress update on it, needs_input for a question only they can answer, blocked when you cannot finish it, done with the result. Leave it out on messages to agents you brought in.";

/** Opens the note on an agent's open jobs; it names hath so the lane never reads it as part of a message. */
const OPEN_JOBS_HEADER = "[Open jobs] A note from hath, not a message: what your sends are held to right now.";

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
 * did nothing on: no reasoning step and no message back, so it was a message that needed
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

/**
 * reportRefusal is why `agent`'s message to `to` carrying `status` must not go out, or
 * null when it may. While `to`'s job is open, every message to `to` carries a status
 * (gate 1), the one progress update is spent once (gate 2), and a question waits for
 * `to`'s reply before another goes (gate 3). A message on no open job passes, unless it carries a status while someone else's job is open (see misaddressedReport).
 */
export async function reportRefusal(
  db: Db,
  agent: string,
  to: string | null,
  status: MessageStatus | undefined,
): Promise<string | null> {
  const job = await openJob(db, to, agent);
  const who = to ?? "Ankur";
  if (job === undefined) {
    return status === undefined ? null : await misaddressedReport(db, agent, who);
  }
  if (status === undefined) {
    return `Not sent: ${who} gave you a job that is still open, so every message to ${who} carries status: running (your one progress update), needs_input (a question only ${who} can answer), blocked (you cannot finish), or done (the result). Send it again with its status.`;
  }
  if (status === "running" && job.progressSeq !== null) {
    return `Not sent: you already sent ${who} your one progress update on this job. Your next message to ${who} is done, blocked, or needs_input; put this in it.`;
  }
  if (status === "needs_input" && job.state === "needs_input") {
    return `Not sent: your question to ${who} is still open and ${who} has not replied since. Do not ask again; wait for the reply.`;
  }
  return null;
}

/**
 * misaddressedReport is why a message carrying a job status must not go to `who`, which
 * gave `agent` no open job, while someone else did: a status is a report on a job, so it
 * belongs to that job's requester. On 2026-10-19 ibio-150-specialist answered Ankur's
 * exam-and-drop question with status done to its parent, education-specialist, and
 * Ankur never got the answer. Null when the agent owes no one a report.
 */
async function misaddressedReport(db: Db, agent: string, who: string): Promise<string | null> {
  const owed = await db
    .select({ requesterId: jobs.requesterId })
    .from(jobs)
    .where(and(eq(jobs.agentId, agent), inArray(jobs.state, [...OPEN_STATES])))
    .orderBy(asc(jobs.openedSeq));
  if (owed.length === 0) {
    return null;
  }
  const requesters = owed.map((job) => (job.requesterId === null ? "Ankur (to_agent_id null)" : job.requesterId)).join(", ");
  return `Not sent: ${who} gave you no open job, so a status does not belong on this message. Your open job is from ${requesters}: send its result there. If ${who} should hear about it too, send that without a status.`;
}

/**
 * openJobsNote is hath's note to one of `agentId`'s lanes on the jobs its sends are held
 * to, so it sends right the first time instead of learning each gate from a refusal:
 * everyone whose open job it owes a status on every message, with whether its one
 * progress update is spent or its question still waits (see reportRefusal), and the
 * agents it gave work that is still open, which the reasoning lane directs and messages
 * itself (see conversation.ts sendRefusal). Null when it has no open job either way.
 */
export async function openJobsNote(db: Db, agentId: string, lane: "conversation" | "reasoning"): Promise<string | null> {
  const owed = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.agentId, agentId), inArray(jobs.state, [...OPEN_STATES])))
    .orderBy(asc(jobs.openedSeq));
  const given = await db
    .select({ agentId: jobs.agentId })
    .from(jobs)
    .where(and(eq(jobs.requesterId, agentId), inArray(jobs.state, [...OPEN_STATES])))
    .orderBy(asc(jobs.agentId));
  if (owed.length === 0 && given.length === 0) {
    return null;
  }
  const lines = owed.map((job) => {
    const who = job.requesterId ?? "Ankur";
    const waiting = `your question to ${who} waits for a reply, so do not ask again`;
    if (lane === "reasoning") {
      const next =
        job.state === "needs_input"
          ? waiting
          : job.progressSeq !== null
            ? "your one progress update is spent, so the next is a result, a blocker or a question"
            : "progress is free for one update";
      return `- ${who} gave you a job that is still open: report on it with hand_off (kind result, blocker, question or progress), and ${next}.`;
    }
    const next =
      job.state === "needs_input"
        ? waiting
        : job.progressSeq !== null
          ? "your one progress update is spent, so the next is done, blocked or needs_input"
          : "running is free for one progress update";
    return `- ${who} gave you a job that is still open: every message to ${who} carries a status, and ${next}. A hand-off from your reasoning lane gets its status from its kind.`;
  });
  if (given.length > 0) {
    const names = given.map((job) => job.agentId).join(", ");
    lines.push(
      lane === "reasoning"
        ? `- You gave work that is still open to ${names}: their reports come to you, and you send them every next step yourself with send_message.`
        : `- You gave work that is still open to ${names}: your reasoning lane directs it and messages them itself, so never message them; to change that work, steer reasoning.`,
    );
  }
  return [OPEN_JOBS_HEADER, ...lines].join("\n");
}
