/**
 * A job's ledger: what the agent has done in it, read from the rows stamped with its id
 * (its messages, its helper steers, its stores, its reminders). The wake header and the
 * agent's status both render it.
 */

import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { formatISO } from "date-fns";
import type { Db } from "../db/client.js";
import { agentActivity, helperSteers, messages, reminders, type JobRow } from "../db/schema.js";
import type { JobLedger } from "../types/domain.js";

/** How much of the job's opening message, and of each message to the requester, the ledger quotes. */
const OPENED_CHARS = 200;
const TOLD_CHARS = 80;

/** How many of the job's newest asks, and of its newest messages to the requester, the ledger lists. */
const LEDGER_ASKS = 12;
const LEDGER_TOLD = 6;

function clip(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit)}…`;
}

/**
 * jobLedger is what `job`'s agent has done in it. The opening message is the one at
 * `job.openedSeq`; an ask is a message the agent sent in the job to an agent other than its
 * requester, answered by that agent's first message back; the helpers are the tasks steered
 * in the job; what it told the requester leaves out hath's own pickups. Throws when the
 * opening message does not exist.
 */
export async function jobLedger(db: Db, job: JobRow): Promise<JobLedger> {
  const [opening] = await db
    .select({ seq: messages.seq, content: messages.content, at: messages.createdAt })
    .from(messages)
    .where(eq(messages.seq, job.openedSeq));
  if (opening === undefined) {
    throw new Error(`job ${job.id} opened at message ${job.openedSeq}, which does not exist`);
  }
  const sent = await db
    .select({ seq: messages.seq, to: messages.toAgentId, content: messages.content, sentBy: messages.sentBy })
    .from(messages)
    .where(and(eq(messages.jobId, job.id), eq(messages.fromAgentId, job.agentId), eq(messages.kind, "message")))
    .orderBy(asc(messages.seq));
  const asked = sent.filter((row) => row.to !== null && row.to !== job.agentId && row.to !== job.requesterId);
  const replies =
    asked.length === 0
      ? []
      : await db
          .select({ seq: messages.seq, from: messages.fromAgentId })
          .from(messages)
          .where(
            and(
              eq(messages.toAgentId, job.agentId),
              inArray(messages.fromAgentId, [...new Set(asked.map((row) => row.to!))]),
              gt(messages.seq, asked[0]!.seq),
              eq(messages.kind, "message"),
            ),
          )
          .orderBy(asc(messages.seq));
  const asks = asked.map((ask) => ({
    to: ask.to!,
    seq: ask.seq,
    answered_seq: replies.find((reply) => reply.from === ask.to && reply.seq > ask.seq)?.seq ?? null,
  }));
  const told = sent
    .filter((row) => row.to === job.requesterId && row.sentBy === null)
    .map((row) => ({ seq: row.seq, preview: clip(row.content, TOLD_CHARS) }));
  const helpers = await db.select({ task: helperSteers.task }).from(helperSteers).where(eq(helperSteers.jobId, job.id));
  const stored = await db
    .select({ subject: agentActivity.subject })
    .from(agentActivity)
    .where(and(eq(agentActivity.jobId, job.id), eq(agentActivity.kind, "store")))
    .orderBy(asc(agentActivity.at));
  const later = await db.select({ at: reminders.runAt }).from(reminders).where(eq(reminders.jobId, job.id)).orderBy(asc(reminders.runAt));
  return {
    job: job.openedSeq,
    requester: job.requesterId,
    opened: { seq: opening.seq, at: formatISO(opening.at), content: clip(opening.content, OPENED_CHARS) },
    answer_by: job.answerBy === null ? null : formatISO(job.answerBy),
    asks: asks.slice(-LEDGER_ASKS),
    helpers: helpers.map((row) => row.task),
    stored: stored.map((row) => row.subject),
    told: told.slice(-LEDGER_TOLD),
    reminders: later.map((row) => formatISO(row.at)),
    stopped: job.stoppedAt === null ? null : { at: formatISO(job.stoppedAt), by: job.stoppedBy ?? "" },
  };
}
