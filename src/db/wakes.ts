/** Durable wake rows: written when a wake is created, closed when its last lane run releases. */

import { and, asc, desc, eq, inArray, lt, min, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { loadMessageRecords } from "./messages.js";
import { agentLogs, messages, wakes, watches, type WakeRow } from "./schema.js";
import { HathError } from "../errors.js";
import {
  isActivityTrimmed,
  orderEntries,
  toTurnEntry,
  toWakeToolResult,
  wakeOutcome,
  WAKE_RESULT_MAX_CHARS,
  type WakeResultRow,
} from "../serialize.js";
import { SEND_MESSAGE, type MessageRecord, type WakeEntry, type WakeOrigin, type WakeRecord, type WakeUsage } from "../types/domain.js";

/** What a wake with no more specific cause is recorded as. */
export const MANUAL_ORIGIN: WakeOrigin = { kind: "manual", ref: null, openedByMessageId: null };

/** Record a wake's start: its id, agent, and structured reason. */
export async function insertWake(
  db: Db,
  args: { id: string; agentId: string; origin: WakeOrigin; startedAt?: Date; endedAt?: Date; error?: string },
): Promise<void> {
  await db.insert(wakes).values({
    id: args.id,
    agentId: args.agentId,
    reasonKind: args.origin.kind,
    reasonRef: args.origin.ref,
    openedByMessageId: args.origin.openedByMessageId,
    ...(args.startedAt !== undefined ? { startedAt: args.startedAt } : {}),
    ...(args.endedAt !== undefined ? { endedAt: args.endedAt } : {}),
    ...(args.error !== undefined ? { error: args.error } : {}),
  });
}

/** Close a wake: when its last lane run released, and the error a lane died with, if any. */
export async function endWake(db: Db, id: string, endedAt: Date, error: string | null): Promise<void> {
  await db.update(wakes).set({ endedAt, error }).where(eq(wakes.id, id));
}

/**
 * Close every wake still open at boot: a restart ended them without a word. Each ends at its
 * last logged step (or its start, when it logged none) with `error` set. Call before any
 * new wake is created.
 */
export async function closeInterruptedWakes(db: Db, error: string): Promise<number> {
  const closed = await db.execute(sql`
    update ${wakes} w
    set ended_at = coalesce((select max(l.created_at) from agent_logs l where l.wake_id = w.id), w.started_at),
        error = ${error}
    where w.ended_at is null
    returning w.id
  `);
  return closed.length;
}

/** The live counts a running wake reports: its tool calls, the messages it sent, the messages it received. */
export type WakeCounts = { tool_calls: number; messages_sent: number; messages_received: number };

/**
 * wakeCounts counts a wake's activity: every tool result logged in it, the successful
 * send_message results among them, and the messages stamped with it.
 */
export async function wakeCounts(db: Db, wakeId: string): Promise<WakeCounts> {
  const [row] = await db.execute<WakeCounts>(sql`
    select
      (select count(*)::int from agent_logs where wake_id = ${wakeId} and event = 'tool_result') as tool_calls,
      (select count(*)::int from agent_logs
        where wake_id = ${wakeId} and event = 'tool_result' and payload->>'name' = ${SEND_MESSAGE} and payload->>'is_error' = 'false') as messages_sent,
      (select count(*)::int from messages where wake_id = ${wakeId}) as messages_received
  `);
  if (!row) {
    throw new Error(`wake counts for ${wakeId} returned no row`);
  }
  return row;
}

/** requireWake loads wake `wakeId` of agent `agentId`, or throws `404 wake_not_found` (also for another agent's wake). */
export async function requireWake(db: Db, agentId: string, wakeId: string): Promise<WakeRow> {
  const [row] = await db.select().from(wakes).where(and(eq(wakes.id, wakeId), eq(wakes.agentId, agentId)));
  if (!row) {
    throw new HathError(404, "wake_not_found", `wake ${wakeId} not found for agent ${agentId}`);
  }
  return row;
}

/** Where a wake page resumes: wakes strictly older than this `(started_at, id)`. */
export type WakeCursor = { startedAt: Date; id: string };

/**
 * listWakes returns up to `limit` of an agent's wakes, newest first by `(started_at, id)`,
 * strictly older than `before` when given. The cursor carries `started_at` at millisecond
 * precision, as the API does; wakes of one agent start far further apart than that. Served
 * by `wakes_agent_id_started_at_idx`.
 */
export async function listWakes(db: Db, agentId: string, opts: { limit: number; before?: WakeCursor }): Promise<WakeRow[]> {
  return db
    .select()
    .from(wakes)
    .where(
      and(
        eq(wakes.agentId, agentId),
        opts.before === undefined
          ? undefined
          : or(
              lt(wakes.startedAt, opts.before.startedAt),
              and(eq(wakes.startedAt, opts.before.startedAt), lt(wakes.id, opts.before.id)),
            ),
      ),
    )
    .orderBy(desc(wakes.startedAt), desc(wakes.id))
    .limit(opts.limit);
}

/**
 * loadWakeRecords builds the API wake for each of `rows` (all of agent `agentId`): usage
 * summed from `response` rows (`agent_logs_wake_id_idx`), counts from {@link wakeCounts}
 * (the same numbers `wake_activity` streams), the opening message, and the derived outcome
 * and `activity_trimmed`.
 */
export async function loadWakeRecords(db: Db, agentId: string, rows: WakeRow[]): Promise<WakeRecord[]> {
  if (rows.length === 0) {
    return [];
  }
  const ids = rows.map((row) => row.id);
  const openerIds = rows.flatMap((row) => row.openedByMessageId ?? []);
  const [[watch], activity, [oldest], counts, openers] = await Promise.all([
    db.select({ since: watches.since }).from(watches).where(eq(watches.agentId, agentId)),
    db
      .select({
        wakeId: agentLogs.wakeId,
        rows: sql<number>`count(*)::int`,
        calls: sql<number>`(count(*) filter (where ${agentLogs.event} = 'response'))::int`,
        input: sql<number>`coalesce(sum((${agentLogs.payload}->'usage'->>'input_tokens')::float8) filter (where ${agentLogs.event} = 'response'), 0)::float8`,
        output: sql<number>`coalesce(sum((${agentLogs.payload}->'usage'->>'output_tokens')::float8) filter (where ${agentLogs.event} = 'response'), 0)::float8`,
        cacheWrite: sql<number>`coalesce(sum((${agentLogs.payload}->'usage'->>'cache_creation_input_tokens')::float8) filter (where ${agentLogs.event} = 'response'), 0)::float8`,
        cacheRead: sql<number>`coalesce(sum((${agentLogs.payload}->'usage'->>'cache_read_input_tokens')::float8) filter (where ${agentLogs.event} = 'response'), 0)::float8`,
      })
      .from(agentLogs)
      .where(inArray(agentLogs.wakeId, ids))
      .groupBy(agentLogs.wakeId),
    db.select({ at: min(agentLogs.createdAt) }).from(agentLogs).where(eq(agentLogs.agentId, agentId)),
    Promise.all(ids.map((id) => wakeCounts(db, id))),
    openerIds.length === 0
      ? Promise.resolve([])
      : db.select().from(messages).where(inArray(messages.id, openerIds)).then((found) => loadMessageRecords(db, found)),
  ]);
  const byWake = new Map(activity.map((row) => [row.wakeId, row]));
  const opened = new Map<string, MessageRecord>(openers.map((message) => [message.id, message]));
  return rows.map((row, index) => {
    const stats = byWake.get(row.id);
    const usage: WakeUsage = {
      calls: stats?.calls ?? 0,
      input_tokens: stats?.input ?? 0,
      output_tokens: stats?.output ?? 0,
      cache_write: stats?.cacheWrite ?? 0,
      cache_read: stats?.cacheRead ?? 0,
    };
    return {
      id: row.id,
      agent_id: row.agentId,
      reason: { kind: row.reasonKind, ref: row.reasonRef },
      opened_by: row.openedByMessageId === null ? null : (opened.get(row.openedByMessageId) ?? null),
      started_at: row.startedAt.toISOString(),
      ended_at: row.endedAt?.toISOString() ?? null,
      outcome: wakeOutcome(row, watch?.since ?? null),
      error: row.error,
      usage,
      counts: counts[index]!,
      activity_trimmed: isActivityTrimmed({
        endedAt: row.endedAt,
        activityRows: stats?.rows ?? 0,
        oldestActivityAt: oldest?.at ?? null,
      }),
    };
  });
}

/**
 * loadWakeEntries is a wake's whole timeline. Messages are those stamped with the wake
 * (received) plus those its agent sent between the wake's start and end, or now while it
 * runs, that are stamped with no other of its wakes (sent): by time, not by the send
 * tool's `message_id`, so they remain when the activity has aged out. Turns are the wake's
 * `response` rows, each call paired by `tool_use_id` with its `tool_result` row, cut to
 * {@link WAKE_RESULT_MAX_CHARS}. See `orderEntries` for the order.
 */
export async function loadWakeEntries(db: Db, wake: WakeRow): Promise<WakeEntry[]> {
  const [messageRows, responses, results] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(
        or(
          eq(messages.wakeId, wake.id),
          and(
            eq(messages.fromAgentId, wake.agentId),
            sql`${messages.createdAt} >= (select started_at from wakes where id = ${wake.id})`,
            sql`${messages.createdAt} <= coalesce((select ended_at from wakes where id = ${wake.id}), now())`,
            sql`${messages.wakeId} is distinct from ${wake.id}`,
          ),
        ),
      )
      .orderBy(asc(messages.seq)),
    db
      .select()
      .from(agentLogs)
      .where(and(eq(agentLogs.wakeId, wake.id), eq(agentLogs.event, "response")))
      .orderBy(asc(agentLogs.createdAt), asc(agentLogs.id)),
    db.execute<{ id: string; tool_use_id: string; is_error: boolean; chars: number; head: string }>(sql`
      select id,
        payload->>'tool_use_id' as tool_use_id,
        (payload->>'is_error') = 'true' as is_error,
        char_length(coalesce(payload->>'content', '')) as chars,
        left(coalesce(payload->>'content', ''), ${WAKE_RESULT_MAX_CHARS}) as head
      from agent_logs
      where wake_id = ${wake.id} and event = 'tool_result'
    `),
  ]);
  const byUse = new Map<string, WakeResultRow>(
    results.map((row) => [
      row.tool_use_id,
      { logId: row.id, result: toWakeToolResult({ head: row.head, chars: row.chars, isError: row.is_error }) },
    ]),
  );
  const records = await loadMessageRecords(db, messageRows);
  return orderEntries(
    records.map((message, index) => ({
      at: message.created_at,
      type: "message" as const,
      direction: messageRows[index]!.wakeId === wake.id ? ("received" as const) : ("sent" as const),
      message,
    })),
    responses.map((row) => toTurnEntry(row, byUse)),
  );
}
