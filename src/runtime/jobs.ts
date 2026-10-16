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
import { RUNTIME_PREFIX } from "../db/messages.js";
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
 * the agent came before the agent's first to it. Hath's `[runtime]` reports never
 * count, as in currentRequester.
 */
export async function opensLine(db: Db, requester: string | null, agent: string): Promise<boolean> {
  const [row] = await db.execute<{ first_in: string | null; first_out: string | null }>(sql`
    select
      (select min(seq) from ${messages}
        where from_agent_id is not distinct from ${requester} and to_agent_id = ${agent}
          and content not like ${`${RUNTIME_PREFIX}%`}) as first_in,
      (select min(seq) from ${messages}
        where from_agent_id = ${agent} and to_agent_id is not distinct from ${requester}
          and content not like ${`${RUNTIME_PREFIX}%`}) as first_out
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
 * its question, or the job's close. Hath's `[runtime]` reports, an agent's notes to
 * itself, and scheduled triggers (a routine's clock, not a request) never touch a job.
 */
export async function recordDelivery(db: Db, row: TranscriptEntry, scheduled: boolean): Promise<void> {
  if (scheduled || row.fromAgentId === row.toAgentId || row.content.startsWith(RUNTIME_PREFIX)) {
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
 * settleWakeJobs settles `agentId`'s open jobs when its wake ends (gate 6). `lines` are
 * the agent's transcript rows since its previous wake ended. A job this wake touched (a
 * message on its line among `lines`, hath's `[runtime]` reports aside) that is still open while the agent has no job of
 * its own out with another agent is over: if the wake did nothing on it (`reasoned`
 * false and no message back), it closes as noop, a message that needed no work;
 * otherwise it closes as blocked and is returned so the caller can tell its requester.
 * Jobs waiting on the requester's answer stay as they are.
 */
export async function settleWakeJobs(
  db: Db,
  lines: TranscriptEntry[],
  agentId: string,
  reasoned: boolean,
): Promise<JobRow[]> {
  const open = await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.state, "open")));
  if (open.length === 0) {
    return [];
  }
  const [delegated] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.requesterId, agentId), inArray(jobs.state, [...OPEN_STATES])))
    .limit(1);
  if (delegated !== undefined) {
    return [];
  }
  const blocked: JobRow[] = [];
  for (const job of open) {
    const onLine = lines.filter(
      (row) =>
        !row.content.startsWith(RUNTIME_PREFIX) &&
        ((row.fromAgentId === job.requesterId && row.toAgentId === agentId) ||
          (row.fromAgentId === agentId && row.toAgentId === job.requesterId)),
    );
    if (onLine.length === 0) {
      continue;
    }
    const answered = onLine.some((row) => row.fromAgentId === agentId);
    const state = !reasoned && !answered ? "noop" : "blocked";
    await db.update(jobs).set({ state, updatedAt: new Date() }).where(eq(jobs.id, job.id));
    if (state === "blocked") {
      blocked.push(job);
    }
  }
  return blocked;
}

/**
 * reportRefusal is why `agent`'s message to `to` carrying `status` must not go out, or
 * null when it may. While `to`'s job is open, every message to `to` carries a status
 * (gate 1), the one progress update is spent once (gate 2), and a question waits for
 * `to`'s reply before another goes (gate 3). Messages on no open job pass.
 */
export async function reportRefusal(
  db: Db,
  agent: string,
  to: string | null,
  status: MessageStatus | undefined,
): Promise<string | null> {
  const job = await openJob(db, to, agent);
  if (job === undefined) {
    return null;
  }
  const who = to ?? "Ankur";
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
 * openJobsNote is hath's note to `agentId`'s conversation lane on the jobs its sends are
 * held to, so it sends right the first time instead of learning each gate from a
 * refusal: everyone whose open job it owes a status on every message, with whether its
 * one progress update is spent or its question still waits (see reportRefusal), and the
 * agents it gave work that is still open, which hear from it only through reasoning's
 * hand-offs (see conversation.ts sendRefusal). Null when it has no open job either way.
 */
export async function openJobsNote(db: Db, agentId: string): Promise<string | null> {
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
    const next =
      job.state === "needs_input"
        ? `your question to ${who} waits for a reply, so do not ask again`
        : job.progressSeq !== null
          ? "your one progress update is spent, so the next is done, blocked or needs_input"
          : "running is free for one progress update";
    return `- ${who} gave you a job that is still open: every message to ${who} carries a status, and ${next}.`;
  });
  if (given.length > 0) {
    lines.push(
      `- You gave work that is still open to ${given.map((job) => job.agentId).join(", ")}: send them each hand-off reasoning gives you for them, as soon as you see it, and nothing else; to change that work, steer reasoning.`,
    );
  }
  return [OPEN_JOBS_HEADER, ...lines].join("\n");
}
