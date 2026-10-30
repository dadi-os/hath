import { toAttachmentSummary, type NewAttachment } from "../db/attachments.js";
import type { Db } from "../db/client.js";
import { awaitingReply, clearAwaitedReply } from "../db/outbox.js";
import { insertMessage, NO_ATTACHMENTS, type MessageAttachments } from "../db/messages.js";
import { writeAgentLog } from "../db/logs.js";
import type { MessageStatus } from "../types/domain.js";
import type { EventBus } from "./events.js";
import { takeWatch } from "./watches.js";
import { recordDelivery } from "./jobs.js";
import type { TranscriptEntry, TranscriptStore } from "./transcript.js";

/**
 * Audit-payload key on a notice's log rows, naming what it is about (see NoticeKind).
 * Boot recovery reads notices to find where an agent's settled history ends.
 */
export const NOTICE = "notice";

/**
 * What a notice is about: a lane that failed, a wake a restart cut short, one of the
 * agent's browser or terminal helpers that finished, stopped, or needs an answer, or the
 * result of one of its async tool calls, or a wait that timed out (the last three sent from the agent to itself, see
 * rewake.ts). A notice is hath's word, never chat, and never sent to Ankur: stored with
 * kind notice, it opens no job and makes no one a requester.
 */
export type NoticeKind = "lane_failed" | "wake_interrupted" | "helper" | "tool" | "wait";

export type DeliverDeps = {
  db: Db;
  transcript: TranscriptStore;
  events: EventBus;
  /** Queue a lane run; returns the id of the wake it joins (see engine.ts). `reason` is why, for the wake's first line. */
  enqueueProcess: (agentId: string, reason?: string) => string;
  enqueueWork: (agentId: string, reason?: string) => string;
  /** The id of an agent's current wake, stamped on the log of a message it sends; null outside a wake. */
  wakeOf?: (agentId: string) => string | null;
};

/**
 * Persist a human → agent message (from_agent_id null) and wake the recipient's
 * process lane once, however many files it carries, or its work lane when it is waiting
 * on Ankur's reply. Shared by POST /messages and the router's send_message and forward_attachment. The null side is logged
 * too, so the router's get_logs sees what Ankur (or it, as him) sent.
 */
export async function deliverUserMessage(
  deps: DeliverDeps,
  toAgentId: string,
  content: string,
  attachments: MessageAttachments = NO_ATTACHMENTS,
): Promise<TranscriptEntry> {
  const row = await insertMessage(deps.db, {
    fromAgentId: null,
    toAgentId,
    content,
    attachments,
  });
  deps.transcript.ingest(row);
  await recordDelivery(deps.db, row, false);
  const attached = row.attachments.map(toAttachmentSummary);
  if (row.id === undefined) {
    throw new Error("durable message missing id");
  }
  await writeAgentLog(deps.db, {
    agentId: null,
    lane: "router",
    event: "message",
    payload: {
      direction: "send",
      message_id: row.id,
      from_agent_id: null,
      to_agent_id: row.toAgentId,
      content: row.content,
      attachments: attached,
      seq: row.seq,
    },
  });
  const awaited = await awaitingReply(deps.db, toAgentId, null);
  if (awaited) {
    await clearAwaitedReply(deps.db, toAgentId, null);
  }
  const wakeId = awaited ? deps.enqueueWork(toAgentId, "reply from Ankur") : deps.enqueueProcess(toAgentId, "message from Ankur");
  await writeAgentLog(deps.db, {
    agentId: toAgentId,
    lane: "process",
    wakeId,
    event: "message",
    payload: {
      direction: "receive",
      message_id: row.id,
      from_agent_id: null,
      to_agent_id: row.toAgentId,
      content: row.content,
      attachments: attached,
      seq: row.seq,
    },
  });
  deps.events.emit({
    type: "message",
    agent_id: toAgentId,
    from_agent_id: null,
    to_agent_id: row.toAgentId,
    content: row.content,
    attachments: attached,
    seq: row.seq,
    at: row.createdAt.toISOString(),
  });
  return row;
}

/**
 * Persist an agent → agent|user message. Shared by send, the scheduled-message ticker
 * and hath's notices. Caller checks agent existence/active before calling. A reply the
 * recipient's work lane is waiting on (it queued a message marked expects_reply to the
 * sender), a wait that names the sender, or a caller that says `wakeWork` wakes the
 * recipient's work lane; any other message wakes its process lane.
 */
export async function deliverAgentMessage(
  deps: DeliverDeps,
  args: {
    fromAgentId: string;
    toAgentId: string | null;
    content: string;
    /** Existing attachments the message carries, by id. */
    attachmentIds?: string[];
    /** New files the message carries, stored with it. */
    uploads?: NewAttachment[];
    extraPayload?: Record<string, unknown>;
    /** False delivers without waking the recipient; it reads the message on its next wake. */
    wake?: boolean;
    /** The job status of an agent's report to whoever gave it the job (see jobs.ts). */
    status?: MessageStatus;
    /** True for a scheduled message firing: a routine's trigger, which opens no job. */
    scheduled?: boolean;
    /** Set for hath's notice that this agent's work stopped, instead of a message it wrote. */
    notice?: NoticeKind;
    /** The sender's lane that sent it, for its log row; the process lane when left out. */
    lane?: "process" | "work";
    /** True wakes the recipient's work lane whoever sent it, as a helper's result does. */
    wakeWork?: boolean;
    /** Why the recipient wakes, for its wake's first line; "message from <sender>" when left out. */
    wokenBy?: string;
  },
): Promise<TranscriptEntry> {
  const extra = { ...(args.extraPayload ?? {}), ...(args.notice !== undefined ? { kind: "notice", [NOTICE]: args.notice } : {}) };
  const row = await insertMessage(deps.db, {
    fromAgentId: args.fromAgentId,
    toAgentId: args.toAgentId,
    content: args.content,
    attachments: { uploads: args.uploads ?? [], forward: args.attachmentIds ?? [] },
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.notice !== undefined ? { kind: "notice" as const } : {}),
  });
  deps.transcript.ingest(row);
  await recordDelivery(deps.db, row, args.scheduled === true);
  const attached = row.attachments.map(toAttachmentSummary);
  if (row.id === undefined) {
    throw new Error("durable message missing id");
  }
  await writeAgentLog(deps.db, {
    agentId: args.fromAgentId,
    lane: args.lane ?? "process",
    wakeId: deps.wakeOf?.(args.fromAgentId) ?? null,
    event: "message",
    payload: {
      direction: "send",
      message_id: row.id,
      from_agent_id: args.fromAgentId,
      to_agent_id: row.toAgentId,
      content: row.content,
      attachments: attached,
      status: row.status,
      seq: row.seq,
      ...extra,
    },
  });
  if (row.toAgentId !== null) {
    let wakeId: string | null = null;
    if (args.wake !== false) {
      const awaited = (await awaitingReply(deps.db, row.toAgentId, args.fromAgentId)) || (await takeWatch(deps.db, row.toAgentId, args.fromAgentId));
      const reason = args.wokenBy ?? `${args.scheduled === true ? "scheduled message" : "message"} from ${args.fromAgentId}`;
      wakeId =
        args.wakeWork === true || awaited
          ? deps.enqueueWork(row.toAgentId, reason)
          : deps.enqueueProcess(row.toAgentId, reason);
      if (awaited) {
        await clearAwaitedReply(deps.db, row.toAgentId, args.fromAgentId);
      }
    }
    await writeAgentLog(deps.db, {
      agentId: row.toAgentId,
      lane: "process",
      wakeId,
      event: "message",
      payload: {
        direction: "receive",
        message_id: row.id,
        from_agent_id: args.fromAgentId,
        to_agent_id: row.toAgentId,
        content: row.content,
        attachments: attached,
        seq: row.seq,
        ...extra,
      },
    });
  } else {
    await writeAgentLog(deps.db, {
      agentId: null,
      lane: "router",
      event: "message",
      payload: {
        direction: "receive",
        message_id: row.id,
        from_agent_id: args.fromAgentId,
        to_agent_id: null,
        content: row.content,
        attachments: attached,
        seq: row.seq,
        ...extra,
      },
    });
  }
  deps.events.emit({
    type: "message",
    agent_id: row.toAgentId ?? args.fromAgentId,
    from_agent_id: args.fromAgentId,
    to_agent_id: row.toAgentId,
    content: row.content,
    attachments: attached,
    seq: row.seq,
    ...(row.kind === "notice" ? { kind: "notice" as const } : {}),
    at: row.createdAt.toISOString(),
  });
  return row;
}
