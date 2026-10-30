/** The work lane's `message` rows, waiting for the process lane to send them (see the `outbox` table). */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { outbox, type OutboxRow } from "./schema.js";

/** The recipient condition for an outbox row, null being Ankur. */
function toIs(recipient: string | null) {
  return recipient === null ? isNull(outbox.toAgentId) : eq(outbox.toAgentId, recipient);
}

/** queueOutbox records what `agentId`'s work lane wants said to `to`, pending. */
export async function queueOutbox(
  db: Db,
  args: { agentId: string; to: string | null; content: string; attachmentIds: string[]; expectsReply: boolean },
): Promise<OutboxRow> {
  const [row] = await db
    .insert(outbox)
    .values({
      agentId: args.agentId,
      toAgentId: args.to,
      content: args.content,
      attachmentIds: args.attachmentIds,
      expectsReply: args.expectsReply,
    })
    .returning();
  if (!row) {
    throw new Error("outbox insert returned no row");
  }
  return row;
}

/** pendingOutbox are `agentId`'s rows still waiting for its process lane, oldest first. */
export async function pendingOutbox(db: Db, agentId: string): Promise<OutboxRow[]> {
  return db
    .select()
    .from(outbox)
    .where(and(eq(outbox.agentId, agentId), eq(outbox.state, "pending")))
    .orderBy(asc(outbox.id));
}

/**
 * markSent closes every row of `agentId` still pending for `to` as sent: the message it
 * became. Rows that expected a reply keep expecting it until the recipient writes.
 */
export async function markSent(db: Db, agentId: string, to: string | null, messageId: string): Promise<OutboxRow[]> {
  return db
    .update(outbox)
    .set({ state: "sent", messageId, resolvedAt: new Date() })
    .where(and(eq(outbox.agentId, agentId), eq(outbox.state, "pending"), toIs(to)))
    .returning();
}

/** failPendingOutbox closes every row `agentId` still has pending as failed and returns them. */
export async function failPendingOutbox(db: Db, agentId: string, reason: string): Promise<OutboxRow[]> {
  return db
    .update(outbox)
    .set({ state: "failed", reason, resolvedAt: new Date(), expectsReply: false })
    .where(and(eq(outbox.agentId, agentId), eq(outbox.state, "pending")))
    .returning();
}

/** awaitingReply is true when `agentId`'s work lane is waiting on `from`'s next message (null is Ankur). */
export async function awaitingReply(db: Db, agentId: string, from: string | null): Promise<boolean> {
  const [row] = await db
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(eq(outbox.agentId, agentId), toIs(from), eq(outbox.expectsReply, true), eq(outbox.state, "sent")))
    .limit(1);
  return row !== undefined;
}

/** clearAwaitedReply ends the wait on `from`'s next message once it has come. */
export async function clearAwaitedReply(db: Db, agentId: string, from: string | null): Promise<void> {
  await db
    .update(outbox)
    .set({ expectsReply: false })
    .where(and(eq(outbox.agentId, agentId), toIs(from), eq(outbox.expectsReply, true)));
}

/** agentsWithPendingOutbox are the agents whose process lane owes a row a send, for boot recovery. */
export async function agentsWithPendingOutbox(db: Db): Promise<string[]> {
  const rows = await db.execute<{ agent_id: string }>(sql`select distinct agent_id from ${outbox} where state = 'pending'`);
  return rows.map((row) => row.agent_id);
}
