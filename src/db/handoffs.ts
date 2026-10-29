/** Hand-offs from an agent's work lane to the process lane that sends them. */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { handoffs, type HandoffRow } from "./schema.js";
import type { HandoffKind } from "../types/domain.js";

/** The recipient condition for a hand-off, null being Ankur. */
function toIs(recipient: string | null) {
  return recipient === null ? isNull(handoffs.toAgentId) : eq(handoffs.toAgentId, recipient);
}

/** createHandoff records what `agentId`'s work lane wants said to `to`, pending. */
export async function createHandoff(
  db: Db,
  args: { agentId: string; to: string | null; kind: HandoffKind; content: string; attachmentIds: string[] },
): Promise<HandoffRow> {
  const [row] = await db
    .insert(handoffs)
    .values({
      agentId: args.agentId,
      toAgentId: args.to,
      kind: args.kind,
      content: args.content,
      attachmentIds: args.attachmentIds,
    })
    .returning();
  if (!row) {
    throw new Error("hand-off insert returned no row");
  }
  return row;
}

/** getHandoff is one hand-off by id, or undefined. */
export async function getHandoff(db: Db, id: number): Promise<HandoffRow | undefined> {
  const [row] = await db.select().from(handoffs).where(eq(handoffs.id, id));
  return row;
}

/** pendingHandoffs are `agentId`'s hand-offs still waiting for its process lane, oldest first. */
export async function pendingHandoffs(db: Db, agentId: string): Promise<HandoffRow[]> {
  return db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.agentId, agentId), eq(handoffs.state, "pending")))
    .orderBy(asc(handoffs.id));
}

/** pendingHandoffTo is the hand-off from `agentId` to `to` still waiting, if there is one. */
export async function pendingHandoffTo(db: Db, agentId: string, to: string | null): Promise<HandoffRow | undefined> {
  const [row] = await db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.agentId, agentId), eq(handoffs.state, "pending"), toIs(to)));
  return row;
}

/**
 * markSent closes a pending hand-off as sent: the message it became, and whether the
 * recipient's next message is the reply its work lane is waiting for.
 */
export async function markSent(db: Db, id: number, messageId: string, expectsReply: boolean): Promise<void> {
  await db
    .update(handoffs)
    .set({ state: "sent", messageId, expectsReply, resolvedAt: new Date() })
    .where(and(eq(handoffs.id, id), eq(handoffs.state, "pending")));
}

/** markDeclined closes a pending hand-off as declined, with the reason its work lane reads. */
export async function markDeclined(db: Db, id: number, reason: string): Promise<void> {
  await db
    .update(handoffs)
    .set({ state: "declined", reason, resolvedAt: new Date() })
    .where(and(eq(handoffs.id, id), eq(handoffs.state, "pending")));
}

/** failPendingHandoffs closes every hand-off `agentId` still has pending as failed and returns them. */
export async function failPendingHandoffs(db: Db, agentId: string, reason: string): Promise<HandoffRow[]> {
  return db
    .update(handoffs)
    .set({ state: "failed", reason, resolvedAt: new Date() })
    .where(and(eq(handoffs.agentId, agentId), eq(handoffs.state, "pending")))
    .returning();
}

/** awaitingReply is true when `agentId`'s work lane is waiting on `from`'s next message. */
export async function awaitingReply(db: Db, agentId: string, from: string): Promise<boolean> {
  const [row] = await db
    .select({ id: handoffs.id })
    .from(handoffs)
    .where(and(eq(handoffs.agentId, agentId), eq(handoffs.toAgentId, from), eq(handoffs.expectsReply, true)))
    .limit(1);
  return row !== undefined;
}

/** clearAwaitedReply ends the wait on `from`'s next message once it has come. */
export async function clearAwaitedReply(db: Db, agentId: string, from: string): Promise<void> {
  await db
    .update(handoffs)
    .set({ expectsReply: false })
    .where(and(eq(handoffs.agentId, agentId), eq(handoffs.toAgentId, from), eq(handoffs.expectsReply, true)));
}

/** agentsWithPendingHandoffs are the agents whose process lane owes a hand-off a decision, for boot recovery. */
export async function agentsWithPendingHandoffs(db: Db): Promise<string[]> {
  const rows = await db.execute<{ agent_id: string }>(sql`select distinct agent_id from ${handoffs} where state = 'pending'`);
  return rows.map((row) => row.agent_id);
}
