/**
 * In-process cache of durable messages and of the steps each agent's reasoning lane
 * took that acted on the world. Hydrated from DB on boot; dies with the process.
 * Rows key by sender and recipient, where null is Ankur. Only agents read a
 * transcript: the router is ephemeral and has none.
 */

import type { AttachmentMeta } from "../db/attachments.js";
import type { MessageStatus } from "../types/domain.js";

export type TranscriptEntry = {
  /** Durable messages.id when loaded from or written to the messages table. */
  id?: string;
  seq: number;
  fromAgentId: string | null;
  toAgentId: string | null;
  content: string;
  /** Files the message carries, in order; metadata only. */
  attachments: AttachmentMeta[];
  /** What an agent's report to whoever gave it the job says about that job; null otherwise. */
  status: MessageStatus | null;
  createdAt: Date;
};

/**
 * One reasoning step that called an action tool, as its agent's transcript shows it
 * (see record.ts stepActions). Built from the step's tool calls, not from a message.
 */
export type ActionEntry = {
  /** When the step's last call returned. */
  createdAt: Date;
  /** The step's text and each action call with its outcome. */
  text: string;
};

/** In-memory inbox and outbox of messages per agent (null is the user), ordered by a monotonic seq. */
export class TranscriptStore {
  private counter = 0;
  private hydrated = 0;
  private readonly inbox = new Map<string | null, TranscriptEntry[]>();
  private readonly outbox = new Map<string | null, TranscriptEntry[]>();
  private readonly actions = new Map<string, ActionEntry[]>();

  /**
   * Ingest a durable (or test) row into inbox/outbox. Advances the local seq
   * watermark so later appends do not collide when used in unit tests.
   */
  ingest(row: TranscriptEntry): void {
    this.counter = Math.max(this.counter, row.seq);
    const inbound = this.inbox.get(row.toAgentId) ?? [];
    inbound.push(row);
    this.inbox.set(row.toAgentId, inbound);
    const outgoing = this.outbox.get(row.fromAgentId) ?? [];
    outgoing.push(row);
    this.outbox.set(row.fromAgentId, outgoing);
  }

  /**
   * Records one message with a process-local seq. Prefer insertMessage + ingest
   * on the live path; tests may still call append directly.
   */
  append(entry: {
    fromAgentId: string | null;
    toAgentId: string | null;
    content: string;
    id?: string;
  }): TranscriptEntry {
    const row: TranscriptEntry = {
      seq: ++this.counter,
      fromAgentId: entry.fromAgentId,
      toAgentId: entry.toAgentId,
      content: entry.content,
      attachments: [],
      status: null,
      createdAt: new Date(),
      ...(entry.id !== undefined ? { id: entry.id } : {}),
    };
    this.ingest(row);
    return row;
  }

  /** Add one of `agentId`'s acting steps; entries arrive oldest first. */
  recordAction(agentId: string, entry: ActionEntry): void {
    const steps = this.actions.get(agentId) ?? [];
    steps.push(entry);
    this.actions.set(agentId, steps);
  }

  /** Every acting step of `agentId`'s reasoning lane, oldest first. */
  actionsFor(agentId: string): ActionEntry[] {
    return this.actions.get(agentId) ?? [];
  }

  /** Mark every message ingested so far as loaded at boot (see hydratedThrough). */
  markHydrated(): void {
    this.hydrated = this.counter;
  }

  /** The newest seq loaded at boot: messages after it arrived while this process ran. */
  get hydratedThrough(): number {
    return this.hydrated;
  }

  /** The seq of the newest message addressed to this agent, or 0 before its first. */
  lastInboundSeq(agentId: string): number {
    return this.inbox.get(agentId)?.at(-1)?.seq ?? 0;
  }

  /**
   * Every inbound message for this agent plus every outbound message from it,
   * sorted by seq.
   */
  transcriptFor(agentId: string): TranscriptEntry[] {
    const inbound = this.inbox.get(agentId) ?? [];
    const outgoing = this.outbox.get(agentId) ?? [];
    const bySeq = new Map<number, TranscriptEntry>();
    for (const row of inbound) bySeq.set(row.seq, row);
    for (const row of outgoing) bySeq.set(row.seq, row);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }
}
