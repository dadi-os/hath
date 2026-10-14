/** Append durable agent log rows (response, tool_result, message), and read acting steps back into transcripts. */

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { agentLogs } from "./schema.js";
import { ACTION_TOOLS, stepActions, type ActionResult } from "../runtime/record.js";
import type { ActionEntry, TranscriptStore } from "../runtime/transcript.js";
import type { DwarContentBlock, Lane, LogEvent } from "../types/domain.js";

/** Appends one event to an agent's (or the router's) durable log. */
export async function writeAgentLog(
  db: Db,
  args: {
    /** Null for the router. */
    agentId: string | null;
    lane: Lane;
    event: LogEvent;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(agentLogs).values({
    id: randomUUID(),
    agentId: args.agentId,
    lane: args.lane,
    event: args.event,
    payload: args.payload,
  });
}

/**
 * How much of each logged action result hydration reads: a record keeps one clipped
 * line of it (see record.ts), and this leaves room for the whitespace that line collapses.
 */
const RESULT_READ_CHARS = 1_000;

/**
 * hydrateActions loads every acting step of every agent's reasoning lane from the log
 * into the transcript as it was recorded live (see record.ts stepActions): each
 * reasoning response that called an action tool, with the logged results of those
 * calls, dated by its last result. A step a restart cut short shows its calls without
 * results. Returns how many steps it loaded.
 */
export async function hydrateActions(db: Db, transcript: TranscriptStore): Promise<number> {
  const names = [...ACTION_TOOLS];
  const steps = await db
    .select({
      agentId: agentLogs.agentId,
      createdAt: agentLogs.createdAt,
      content: sql<DwarContentBlock[]>`(select jsonb_agg(b) from jsonb_array_elements(${agentLogs.payload}->'content') b where b->>'type' in ('text', 'tool_use'))`,
    })
    .from(agentLogs)
    .where(
      and(
        eq(agentLogs.event, "response"),
        eq(agentLogs.lane, "reasoning"),
        isNotNull(agentLogs.agentId),
        sql`exists (select 1 from jsonb_array_elements(${agentLogs.payload}->'content') b where b->>'type' = 'tool_use' and b->>'name' in (${sql.join(
          names.map((name) => sql`${name}`),
          sql`, `,
        )}))`,
      ),
    )
    .orderBy(asc(agentLogs.createdAt));
  const results = await db
    .select({
      toolUseId: sql<string>`${agentLogs.payload}->>'tool_use_id'`,
      content: sql<string>`left(${agentLogs.payload}->>'content', ${RESULT_READ_CHARS})`,
      isError: sql<boolean>`(${agentLogs.payload}->>'is_error')::boolean`,
      createdAt: agentLogs.createdAt,
    })
    .from(agentLogs)
    .where(
      and(
        eq(agentLogs.event, "tool_result"),
        eq(agentLogs.lane, "reasoning"),
        inArray(sql`${agentLogs.payload}->>'name'`, names),
      ),
    );
  const byCall = new Map(results.map((result) => [result.toolUseId, result]));

  const entries: { agentId: string; entry: ActionEntry }[] = [];
  for (const step of steps) {
    if (step.agentId === null) {
      throw new Error("reasoning response logged without an agent");
    }
    const logged = new Map<string, ActionResult & { createdAt: Date }>();
    for (const block of step.content) {
      const result = block.type === "tool_use" ? byCall.get(block.id) : undefined;
      if (result !== undefined) {
        logged.set(result.toolUseId, { content: result.content, is_error: result.isError, createdAt: result.createdAt });
      }
    }
    const text = stepActions(step.content, logged);
    if (text === null) {
      throw new Error(`reasoning response of ${step.agentId} at ${step.createdAt.toISOString()} matched an action tool but has none`);
    }
    const createdAt = [...logged.values()].reduce((last, result) => (result.createdAt > last ? result.createdAt : last), step.createdAt);
    entries.push({ agentId: step.agentId, entry: { createdAt, text } });
  }
  entries.sort((a, b) => a.entry.createdAt.getTime() - b.entry.createdAt.getTime());
  for (const { agentId, entry } of entries) {
    transcript.recordAction(agentId, entry);
  }
  return entries.length;
}
