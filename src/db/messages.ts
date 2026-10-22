/** Durable message inserts, thread queries, and transcript hydrate helpers. */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  attachmentsByMessage,
  attachToMessage,
  toAttachmentSummary,
  type AttachmentMeta,
  type NewAttachment,
} from "./attachments.js";
import type { AttachmentSummary, MessageKind, MessageStatus } from "../types/domain.js";
import { HathError } from "../errors.js";
import type { Db } from "./client.js";
import { agents, messages, threadReads, type MessageRow } from "./schema.js";
import type { TranscriptEntry, TranscriptStore } from "../runtime/transcript.js";


/**
 * currentRequester returns who an agent is working for right now: of everyone
 * who opened a line to it (messaged it before it ever messaged them), the one
 * who wrote to it most recently, with null for Ankur. Agents it brought in
 * itself, such as a worker reporting back, are downstream and never count, and
 * hath's notices are skipped in both directions. An agent no one has opened a line to
 * answers to its parent. Throws when the agent does not exist.
 */
export async function currentRequester(db: Db, agentId: string): Promise<string | null> {
  const rows = await db.execute<{ sender: string | null }>(sql`
    with inbound as (
      select from_agent_id as sender, min(seq) as first_in, max(seq) as last_in
      from ${messages}
      where to_agent_id = ${agentId}
        and from_agent_id is distinct from ${agentId}
        and kind = 'message'
      group by from_agent_id
    ),
    outbound as (
      select to_agent_id as recipient, min(seq) as first_out
      from ${messages}
      where from_agent_id = ${agentId}
        and kind = 'message'
      group by to_agent_id
    )
    select i.sender
    from inbound i
    left join outbound o on o.recipient is not distinct from i.sender
    where o.first_out is null or i.first_in < o.first_out
    order by i.last_in desc
    limit 1
  `);
  const [row] = rows;
  if (row) {
    return row.sender;
  }
  const [agent] = await db.select({ parentAgentId: agents.parentAgentId }).from(agents).where(eq(agents.id, agentId));
  if (!agent) {
    throw new Error(`agent ${agentId} not found`);
  }
  return agent.parentAgentId;
}

export type MessageAttachments = {
  uploads: NewAttachment[];
  forward: string[];
};

/** A message that carries no files. */
export const NO_ATTACHMENTS: MessageAttachments = { uploads: [], forward: [] };

/** Insert one durable message and its attachments in one transaction; return it as a transcript entry (stable seq). */
export async function insertMessage(
  db: Db,
  args: {
    fromAgentId: string | null;
    toAgentId: string | null;
    content: string;
    attachments: MessageAttachments;
    /** The job status an agent's report carries; absent on every other message. */
    status?: MessageStatus;
    /** notice for hath's word that an agent's work stopped; message when left out. */
    kind?: MessageKind;
  },
): Promise<TranscriptEntry> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({
        id: randomUUID(),
        fromAgentId: args.fromAgentId,
        toAgentId: args.toAgentId,
        content: args.content,
        status: args.status ?? null,
        kind: args.kind ?? "message",
      })
      .returning();
    if (!row) {
      throw new Error("insert message returned no row");
    }
    const attached = await attachToMessage(tx, row.id, args.fromAgentId, args.attachments);
    return messageToTranscriptEntry(row, attached);
  });
}

/** Map a DB message row and its attachments into a transcript entry. */
export function messageToTranscriptEntry(
  row: MessageRow,
  attachments: AttachmentMeta[],
): TranscriptEntry {
  return {
    id: row.id,
    seq: row.seq,
    fromAgentId: row.fromAgentId,
    toAgentId: row.toAgentId,
    content: row.content,
    attachments,
    status: row.status,
    kind: row.kind,
    createdAt: row.createdAt,
  };
}

/** Load all durable messages and their attachment metadata into the in-process transcript cache (startup resume). */
export async function hydrateTranscript(db: Db, transcript: TranscriptStore): Promise<number> {
  const rows = await db.select().from(messages).orderBy(asc(messages.seq));
  const attached = await attachmentsByMessage(db);
  for (const row of rows) {
    transcript.ingest(messageToTranscriptEntry(row, attached.get(row.id) ?? []));
  }
  transcript.markHydrated();
  return rows.length;
}

/** Human↔agent filter: exactly one party is null. */
const humanThread = or(
  and(isNull(messages.fromAgentId), isNotNull(messages.toAgentId)),
  and(isNotNull(messages.fromAgentId), isNull(messages.toAgentId)),
);

export type ThreadSummary = {
  agent_id: string;
  agent_name: string;
  last_message: string;
  last_at: string;
  from_user: boolean;
  /** The agent's messages to Ankur after `read_seq`; notices are not counted. */
  unread: number;
  /** The last message Ankur has read in this thread; null until he reads it. */
  read_seq: number | null;
};

/**
 * Conversation summaries for human↔agent threads (desktop sidebar shape).
 * One row per active agent that has at least one human-thread message; a
 * retired agent's thread leaves the list (its history stays readable by id).
 */
export async function listThreads(db: Db): Promise<ThreadSummary[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(humanThread)
    .orderBy(asc(messages.seq));

  const reads = await db.select().from(threadReads);
  const readSeqByAgent = new Map(reads.map((row) => [row.agentId, row.readSeq]));

  const byAgent = new Map<string, { summary: Omit<ThreadSummary, "agent_name"> }>();
  for (const row of rows) {
    const agentId = row.fromAgentId ?? row.toAgentId;
    if (!agentId) {
      throw new Error("human-thread message missing agent party");
    }
    const readSeq = readSeqByAgent.get(agentId) ?? null;
    const unseen = row.fromAgentId !== null && row.kind === "message" && (readSeq === null || row.seq > readSeq);
    const unread = (byAgent.get(agentId)?.summary.unread ?? 0) + (unseen ? 1 : 0);
    byAgent.set(agentId, {
      summary: {
        agent_id: agentId,
        last_message: row.content,
        last_at: row.createdAt.toISOString(),
        from_user: row.fromAgentId === null,
        unread,
        read_seq: readSeq,
      },
    });
  }

  const ids = [...byAgent.keys()];
  if (ids.length === 0) return [];

  const agentRows = await db
    .select({ id: agents.id, active: agents.active })
    .from(agents)
    .where(inArray(agents.id, ids));
  const activeById = new Map(agentRows.map((row) => [row.id, row.active]));

  return [...byAgent.values()]
    .filter(({ summary }) => {
      const active = activeById.get(summary.agent_id);
      if (active === undefined) {
        throw new Error(`thread agent missing: ${summary.agent_id}`);
      }
      return active;
    })
    .map(({ summary }) => ({ ...summary, agent_name: summary.agent_id }))
    .sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
}

/**
 * Marks `agentId`'s thread read through `seq`, never moving the mark back, and
 * returns where it now stands with what is still unread.
 * @throws `422 invalid_request` when `seq` is past the thread's newest message.
 */
export async function markThreadRead(
  db: Db,
  agentId: string,
  seq: number,
): Promise<{ read_seq: number; unread: number }> {
  const [newest] = await db
    .select({ seq: sql<number | null>`max(${messages.seq})` })
    .from(messages)
    .where(and(humanThread, or(eq(messages.fromAgentId, agentId), eq(messages.toAgentId, agentId))));
  const newestSeq = newest?.seq;
  if (newestSeq === null || newestSeq === undefined || seq > Number(newestSeq)) {
    throw new HathError(422, "invalid_request", `seq ${seq} is past the newest message in ${agentId}'s thread`);
  }
  const [mark] = await db
    .insert(threadReads)
    .values({ agentId, readSeq: seq })
    .onConflictDoUpdate({
      target: threadReads.agentId,
      set: { readSeq: sql`greatest(${threadReads.readSeq}, excluded.read_seq)`, readAt: sql`now()` },
    })
    .returning({ readSeq: threadReads.readSeq });
  if (!mark) {
    throw new Error(`thread read mark for ${agentId} was not written`);
  }
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.fromAgentId, agentId),
        isNull(messages.toAgentId),
        eq(messages.kind, "message"),
        gt(messages.seq, mark.readSeq),
      ),
    );
  if (!count) {
    throw new Error(`unread count for ${agentId} returned no row`);
  }
  return { read_seq: mark.readSeq, unread: count.n };
}

export type HumanMessageRecord = {
  id: string;
  seq: number;
  from_agent_id: string | null;
  to_agent_id: string | null;
  content: string;
  attachments: AttachmentSummary[];
  /** notice: hath's word that the agent's work stopped, shown as a system line, never as its message. */
  kind: MessageKind;
  created_at: string;
};

/**
 * Human↔agent messages for one agent, oldest first. With `since_seq` (exclusive)
 * it pages forward from that seq; without it, it returns the newest `limit` rows
 * so a long thread opens on its latest messages. `limit` defaults to 200 via the
 * route schema.
 */
export async function listHumanMessages(
  db: Db,
  agentId: string,
  opts: { sinceSeq?: number; limit: number },
): Promise<HumanMessageRecord[]> {
  const party = or(eq(messages.fromAgentId, agentId), eq(messages.toAgentId, agentId));
  const rows =
    opts.sinceSeq !== undefined
      ? await db
          .select()
          .from(messages)
          .where(and(party, humanThread, gt(messages.seq, opts.sinceSeq)))
          .orderBy(asc(messages.seq))
          .limit(opts.limit)
      : (
          await db
            .select()
            .from(messages)
            .where(and(party, humanThread))
            .orderBy(desc(messages.seq))
            .limit(opts.limit)
        ).reverse();
  const attached = await attachmentsByMessage(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    from_agent_id: row.fromAgentId,
    to_agent_id: row.toAgentId,
    content: row.content,
    attachments: (attached.get(row.id) ?? []).map(toAttachmentSummary),
    kind: row.kind,
    created_at: row.createdAt.toISOString(),
  }));
}
