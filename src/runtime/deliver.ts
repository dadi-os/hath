import { toAttachmentSummary, type NewAttachment } from "../db/attachments.js";
import type { Db } from "../db/client.js";
import { insertMessage, NO_ATTACHMENTS, type MessageAttachments } from "../db/messages.js";
import { writeAgentLog } from "../db/logs.js";
import type { MessageStatus } from "../types/domain.js";
import type { EventBus } from "./events.js";
import { opensLine, recordDelivery } from "./jobs.js";
import type { TranscriptEntry, TranscriptStore } from "./transcript.js";

/**
 * Audit-payload key on a message the runtime sends on an agent's behalf (a
 * failed lane, or a wake a restart cut short). Boot recovery reads it to find
 * where an agent's settled history ends, without parsing message text.
 */
export const RUNTIME_REPORT = "runtime_report";

/**
 * What a runtime report is about, stored under `RUNTIME_REPORT`. A `wake_record` is the
 * agent's note to itself listing what a finished wake did (see record.ts); a
 * `job_unfinished` tells a requester its job closed as blocked when the agent's wake
 * ended without reporting on it (see jobs.ts).
 */
export type RuntimeReportKind = "lane_failed" | "wake_interrupted" | "wake_record" | "job_unfinished";

export type DeliverDeps = {
  db: Db;
  transcript: TranscriptStore;
  events: EventBus;
  enqueueConversation: (agentId: string) => void;
  enqueueReasoning: (agentId: string) => void;
};

/**
 * Persist a human → agent message (from_agent_id null) and wake the recipient's
 * conversation lane once, however many files it carries. Shared by POST /messages
 * and the router's send_message and forward_attachment. The null side is logged
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
  await writeAgentLog(deps.db, {
    agentId: toAgentId,
    lane: "conversation",
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
  deps.enqueueConversation(toAgentId);
  return row;
}

/**
 * Persist an agent → agent|user message. Shared by dispatch_message,
 * forward_attachment and the scheduled-message ticker. Caller checks agent
 * existence/active before calling. A message from an agent the recipient opened
 * the line to (its worker or helper, reporting back) wakes the recipient's reasoning
 * lane, which directs that work; any other message wakes its conversation lane.
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
  },
): Promise<TranscriptEntry> {
  const extra = args.extraPayload ?? {};
  const row = await insertMessage(deps.db, {
    fromAgentId: args.fromAgentId,
    toAgentId: args.toAgentId,
    content: args.content,
    attachments: { uploads: args.uploads ?? [], forward: args.attachmentIds ?? [] },
    ...(args.status !== undefined ? { status: args.status } : {}),
  });
  deps.transcript.ingest(row);
  await recordDelivery(deps.db, row, args.scheduled === true);
  const attached = row.attachments.map(toAttachmentSummary);
  if (row.id === undefined) {
    throw new Error("durable message missing id");
  }
  await writeAgentLog(deps.db, {
    agentId: args.fromAgentId,
    lane: "conversation",
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
    await writeAgentLog(deps.db, {
      agentId: row.toAgentId,
      lane: "conversation",
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
    if (args.wake !== false) {
      if (await opensLine(deps.db, row.toAgentId, args.fromAgentId)) {
        deps.enqueueReasoning(row.toAgentId);
      } else {
        deps.enqueueConversation(row.toAgentId);
      }
    }
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
    at: row.createdAt.toISOString(),
  });
  return row;
}
