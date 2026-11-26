import type { Db } from "../db/client.js";
import { insertMessage, stampMessageJob, stampMessageWake } from "../db/messages.js";
import { jobById, recordStatus } from "./jobs.js";
import { outgoingJob, resolveInbound } from "./job-of.js";
import type { MessageStatus, WakeOrigin } from "../types/domain.js";
import type { EventBus } from "./events.js";
import type { WakeActivity } from "./wake-activity.js";
import { takeWatch } from "./watches.js";
import type { TranscriptEntry, TranscriptStore } from "./transcript.js";

/**
 * What a notice is about: a run that failed, a wake a restart cut short, one of the
 * agent's browser or terminal helpers that finished, stopped, or needs an answer, or the
 * result of one of its async tool calls, or a wait that timed out (the last three sent from the agent to itself, see
 * rewake.ts). A notice is hath's word, never chat, and never sent to Ankur: stored with
 * kind notice, it opens no job and makes no one a requester.
 */
export type NoticeKind = "run_failed" | "wake_interrupted" | "helper" | "tool" | "wait" | "routine" | "reminder" | "answer_by";

export type DeliverDeps = {
  db: Db;
  transcript: TranscriptStore;
  events: EventBus;
  /** Queue a run; returns the id of the wake it joins (see engine.ts). `reason` is why, for the wake's first line; `origin` is why, for the wake's row. */
  enqueue: (agentId: string, reason?: string, origin?: WakeOrigin) => string;
  /** Cancels the model call `agentId`'s running loop has out, when its wake is on job `jobId` (see engine.ts). */
  preempt: (agentId: string, jobId: string) => void;
  /** Told of each message that opened or joined a wake, so the wake reports its new count (see wake-activity.ts). */
  wakeActivity?: WakeActivity;
  /** `runtime.answer_by_minutes`: a job Ankur opens is due this long after his message. */
  answerByMinutes: number;
};

/**
 * Persist a human → agent message (from_agent_id null) and wake the recipient once.
 * Shared by POST /messages and the router's send_message. The message is stamped with the wake it opened or joined, and with
 * the job it belongs to; when that job is the one the recipient is running, the model call
 * in flight is cancelled so the loop reads the message first.
 */
export async function deliverUserMessage(
  deps: DeliverDeps,
  toAgentId: string,
  content: string,
): Promise<TranscriptEntry> {
  const row = await insertMessage(deps.db, {
    fromAgentId: null,
    toAgentId,
    content,
  });
  deps.transcript.ingest(row);
  if (row.id === undefined) {
    throw new Error("durable message missing id");
  }
  const resolved = await resolveInbound(deps.db, { seq: row.seq, fromAgentId: null, toAgentId }, deps.answerByMinutes, new Date());
  if (resolved !== null) {
    await stampMessageJob(deps.db, row.id, resolved.job.id);
    row.jobId = resolved.job.id;
    row.jobNumber = resolved.job.openedSeq;
  }
  const origin: WakeOrigin = {
    kind: "message",
    ref: null,
    openedByMessageId: row.id,
    ...(resolved !== null ? { jobId: resolved.job.id, jobIsNew: resolved.isNew } : {}),
  };
  const wakeId = deps.enqueue(toAgentId, "message from Ankur", origin);
  if (resolved !== null) {
    deps.preempt(toAgentId, resolved.job.id);
  }
  await stampMessageWake(deps.db, row.id, wakeId);
  deps.wakeActivity?.touch(toAgentId, wakeId);
  deps.events.emit({
    type: "message",
    agent_id: toAgentId,
    from_agent_id: null,
    to_agent_id: row.toAgentId,
    content: row.content,
    seq: row.seq,
    at: row.createdAt.toISOString(),
  });
  return row;
}

/**
 * Persist an agent → agent|user message. Shared by send, the routine and reminder tickers and
 * hath's notices. Caller checks agent existence/active before calling. A message from an agent
 * is stamped with the sender's job (see job-of.ts outgoingJob); one that reaches an agent is
 * resolved to the recipient's job and stamped with it when it comes from Ankur or is a notice,
 * and a status on a message to the job's requester updates the job (see jobs.ts recordStatus).
 * The message wakes the recipient; one from the requester of the job the recipient is running
 * also cancels the model call in flight.
 */
export async function deliverAgentMessage(
  deps: DeliverDeps,
  args: {
    fromAgentId: string;
    toAgentId: string | null;
    content: string;
    /** The routine or reminder that fired it, when one did; its id is the wake's reason. */
    scheduleId?: string;
    /** Set when hath sent it for the agent (see TranscriptEntry.sentBy). */
    sentBy?: "hath";
    /** False delivers without waking the recipient; it reads the message on its next wake. */
    wake?: boolean;
    /** The job status of an agent's report to whoever gave it the job (see jobs.ts). */
    status?: MessageStatus;
    /** Set for hath's notice to an agent, instead of a message it wrote. */
    notice?: NoticeKind;
    /** Why the recipient wakes, for its wake's first line; "message from <sender>" when left out. */
    wokenBy?: string;
    /**
     * The job the message belongs to when the caller knows it: the sender's current job for a
     * message, the job a notice is about for a notice (a helper report's, a reminder's).
     */
    jobId?: string | null;
    /** True when this notice opened that job. */
    jobIsNew?: boolean;
    /** For a notice that opens a job of its own (a routine firing): called with the written row, returns the job's id. */
    opens?: (row: TranscriptEntry) => Promise<string>;
  },
): Promise<TranscriptEntry> {
  const row = await insertMessage(deps.db, {
    fromAgentId: args.fromAgentId,
    toAgentId: args.toAgentId,
    content: args.content,
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.notice !== undefined ? { kind: "notice" as const } : {}),
    ...(args.sentBy === "hath" ? { sentBy: "hath" as const } : {}),
  });
  if (args.sentBy !== undefined) {
    row.sentBy = args.sentBy;
  }
  deps.transcript.ingest(row);
  if (row.id === undefined) {
    throw new Error("durable message missing id");
  }
  const opened = args.opens === undefined ? null : await args.opens(row);
  const noticeJob = opened ?? args.jobId ?? null;
  const toAgent = args.notice === undefined && row.toAgentId !== null && row.toAgentId !== args.fromAgentId;
  const resolved = toAgent
    ? await resolveInbound(deps.db, { seq: row.seq, fromAgentId: args.fromAgentId, toAgentId: row.toAgentId! }, deps.answerByMinutes, new Date())
    : null;
  const stamped =
    args.notice !== undefined
      ? noticeJob
      : await outgoingJob(deps.db, args.fromAgentId, row.toAgentId, args.jobId ?? null);
  if (stamped !== null) {
    await stampMessageJob(deps.db, row.id, stamped);
    row.jobId = stamped;
    row.jobNumber = resolved?.job.openedSeq ?? (await jobById(deps.db, stamped)).openedSeq;
    if (args.notice === undefined) {
      await recordStatus(deps.db, await jobById(deps.db, stamped), row);
    }
  }
  if (row.toAgentId !== null && args.wake !== false) {
    const reason = args.wokenBy ?? `message from ${args.fromAgentId}`;
    const wakeJob = args.notice !== undefined ? (noticeJob ?? undefined) : resolved?.job.id;
    const origin: WakeOrigin = {
      kind: args.scheduleId !== undefined ? "schedule" : "message",
      ref: args.scheduleId ?? args.fromAgentId,
      openedByMessageId: row.id,
      ...(wakeJob !== undefined ? { jobId: wakeJob, jobIsNew: args.notice !== undefined ? opened !== null || args.jobIsNew === true : resolved?.isNew === true } : {}),
    };
    await takeWatch(deps.db, row.toAgentId, args.fromAgentId);
    const wakeId = deps.enqueue(row.toAgentId, reason, origin);
    if (resolved !== null && resolved.job.requesterId === args.fromAgentId) {
      deps.preempt(row.toAgentId, resolved.job.id);
    }
    await stampMessageWake(deps.db, row.id, wakeId);
    deps.wakeActivity?.touch(row.toAgentId, wakeId);
  }
  deps.events.emit({
    type: "message",
    agent_id: row.toAgentId ?? args.fromAgentId,
    from_agent_id: args.fromAgentId,
    to_agent_id: row.toAgentId,
    content: row.content,
    seq: row.seq,
    ...(row.kind === "notice" ? { kind: "notice" as const } : {}),
    at: row.createdAt.toISOString(),
  });
  return row;
}
