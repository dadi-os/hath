import type { Db } from "../db/client.js";
import { insertMessage, messageToTranscriptEntry } from "../db/messages.js";
import { writeAgentLog } from "../db/logs.js";
import type { EventBus } from "./events.js";
import type { TranscriptEntry, TranscriptStore } from "./transcript.js";

/**
 * Audit-payload key on a message the runtime sends on an agent's behalf (a
 * failed lane, or a wake a restart cut short). Boot recovery reads it to find
 * where an agent's settled history ends, without parsing message text.
 */
export const RUNTIME_REPORT = "runtime_report";

/** What a runtime report is about, stored under `RUNTIME_REPORT`. */
export type RuntimeReportKind = "lane_failed" | "wake_interrupted";

export type DeliverDeps = {
  db: Db;
  transcript: TranscriptStore;
  events: EventBus;
  enqueueConversation: (agentId: string) => void;
};

/**
 * Persist a human → agent message (from_agent_id null) and wake the recipient's
 * conversation lane. Shared by POST /messages and the router's send_message. The
 * null side is logged too, so the router's get_logs sees what Ankur (or it, as
 * him) sent.
 */
export async function deliverUserMessage(
  deps: DeliverDeps,
  toAgentId: string,
  content: string,
): Promise<TranscriptEntry> {
  const stored = await insertMessage(deps.db, {
    fromAgentId: null,
    toAgentId,
    content,
  });
  const row = messageToTranscriptEntry(stored);
  deps.transcript.ingest(row);
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
      seq: row.seq,
    },
  });
  deps.events.emit({
    type: "message",
    agent_id: toAgentId,
    from_agent_id: null,
    to_agent_id: row.toAgentId,
    content: row.content,
    seq: row.seq,
    at: row.createdAt.toISOString(),
  });
  deps.enqueueConversation(toAgentId);
  return row;
}

/**
 * Persist an agent → agent|user message. Shared by dispatch_message and the
 * scheduled-message ticker. Caller checks agent existence/active before calling.
 */
export async function deliverAgentMessage(
  deps: DeliverDeps,
  args: {
    fromAgentId: string;
    toAgentId: string | null;
    content: string;
    extraPayload?: Record<string, unknown>;
  },
): Promise<TranscriptEntry> {
  const extra = args.extraPayload ?? {};
  const stored = await insertMessage(deps.db, {
    fromAgentId: args.fromAgentId,
    toAgentId: args.toAgentId,
    content: args.content,
  });
  const row = messageToTranscriptEntry(stored);
  deps.transcript.ingest(row);
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
        seq: row.seq,
        ...extra,
      },
    });
    deps.enqueueConversation(row.toAgentId);
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
    seq: row.seq,
    at: row.createdAt.toISOString(),
  });
  return row;
}
