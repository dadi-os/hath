/** Durable message inserts, thread queries, and transcript hydrate helpers. */

import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "./client.js";
import { agents, messages, type MessageRow } from "./schema.js";
import type { TranscriptEntry, TranscriptStore } from "../runtime/transcript.js";

/** Insert one durable message and return the row (stable seq). */
export async function insertMessage(
  db: Db,
  args: {
    fromAgentId: string | null;
    toAgentId: string | null;
    content: string;
  },
): Promise<MessageRow> {
  const [row] = await db
    .insert(messages)
    .values({
      id: randomUUID(),
      fromAgentId: args.fromAgentId,
      toAgentId: args.toAgentId,
      content: args.content,
    })
    .returning();
  if (!row) {
    throw new Error("insert message returned no row");
  }
  return row;
}

/** Map a DB message row into a transcript entry. */
export function messageToTranscriptEntry(row: MessageRow): TranscriptEntry {
  return {
    id: row.id,
    seq: row.seq,
    fromAgentId: row.fromAgentId,
    toAgentId: row.toAgentId,
    content: row.content,
    createdAt: row.createdAt,
  };
}

/** Load all durable messages into the in-process transcript cache (startup resume). */
export async function hydrateTranscript(db: Db, transcript: TranscriptStore): Promise<number> {
  const rows = await db.select().from(messages).orderBy(asc(messages.seq));
  for (const row of rows) {
    transcript.ingest(messageToTranscriptEntry(row));
  }
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

  const byAgent = new Map<string, { summary: Omit<ThreadSummary, "agent_name"> }>();
  for (const row of rows) {
    const agentId = row.fromAgentId ?? row.toAgentId;
    if (!agentId) {
      throw new Error("human-thread message missing agent party");
    }
    byAgent.set(agentId, {
      summary: {
        agent_id: agentId,
        last_message: row.content,
        last_at: row.createdAt.toISOString(),
        from_user: row.fromAgentId === null,
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

export type HumanMessageRecord = {
  id: string;
  seq: number;
  from_agent_id: string | null;
  to_agent_id: string | null;
  content: string;
  created_at: string;
};

/**
 * Ordered human↔agent messages for one agent. Optional `since_seq` (exclusive);
 * `limit` defaults to 200 via the route schema.
 */
export async function listHumanMessages(
  db: Db,
  agentId: string,
  opts: { sinceSeq?: number; limit: number },
): Promise<HumanMessageRecord[]> {
  const party = or(eq(messages.fromAgentId, agentId), eq(messages.toAgentId, agentId));
  const filter =
    opts.sinceSeq !== undefined
      ? and(party, humanThread, gt(messages.seq, opts.sinceSeq))
      : and(party, humanThread);
  const rows = await db
    .select()
    .from(messages)
    .where(filter)
    .orderBy(asc(messages.seq))
    .limit(opts.limit);
  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    from_agent_id: row.fromAgentId,
    to_agent_id: row.toAgentId,
    content: row.content,
    created_at: row.createdAt.toISOString(),
  }));
}
