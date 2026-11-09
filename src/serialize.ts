/** Map Drizzle agent/log/scheduled-message rows to API snake_case records. */

import { z } from "zod";
import type { AttachmentMeta } from "./db/attachments.js";
import { toAttachmentSummary } from "./db/attachments.js";
import type { AgentLogRow, AgentRow, MessageRow, ScheduledMessageRow } from "./db/schema.js";
import type {
  AgentRecord,
  LogEvent,
  LogRecord,
  Lane,
  MessageRecord,
  ScheduledMessageRecord,
  WakeEntry,
  WakeOutcome,
  WakeToolCall,
  WakeToolResult,
} from "./types/domain.js";
import { HathError } from "./errors.js";

function parseLane(value: string): Lane {
  if (value === "work" || value === "process" || value === "router") {
    return value;
  }
  throw new HathError(500, "internal_error", `invalid lane in database: ${value}`);
}

function parseLogEvent(value: string): LogEvent {
  if (value === "response" || value === "tool_result") {
    return value;
  }
  throw new HathError(500, "internal_error", `invalid log event in database: ${value}`);
}

/** Agent row without ephemeral `running` / `sessions` (filled by routers). */
export function toAgentRecord(row: AgentRow): Omit<AgentRecord, "running" | "sessions"> {
  return {
    id: row.id,
    /** Display alias of the immutable kebab-case id (desktop / roster compat). */
    name: row.id,
    system_prompt: row.systemPrompt,
    description: row.description,
    parent_agent_id: row.parentAgentId,
    active: row.active,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toLogRecord(row: AgentLogRow): LogRecord {
  return {
    id: row.id,
    agent_id: row.agentId,
    lane: parseLane(row.lane),
    event: parseLogEvent(row.event),
    payload: row.payload,
    wake_id: row.wakeId,
    created_at: row.createdAt.toISOString(),
  };
}

export function toScheduledMessageRecord(row: ScheduledMessageRow): ScheduledMessageRecord {
  return {
    id: row.id,
    from_agent_id: row.fromAgentId,
    to_agent_id: row.toAgentId,
    content: row.content,
    run_at: row.runAt.toISOString(),
    interval_minutes: row.intervalMinutes,
    created_at: row.createdAt.toISOString(),
  };
}

/** The most characters of one tool result a wake detail carries; the whole row is `GET /agents/:id/logs/:log_id`. */
export const WAKE_RESULT_MAX_CHARS = 8_000;

/** Map a message row and its attachments to the API record shared by wake routes and tools. */
export function toMessageRecord(row: MessageRow, attachments: AttachmentMeta[]): MessageRecord {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    status: row.status,
    from_agent_id: row.fromAgentId,
    to_agent_id: row.toAgentId,
    content: row.content,
    created_at: row.createdAt.toISOString(),
    attachments: attachments.map(toAttachmentSummary),
  };
}

/**
 * wakeOutcome derives where a wake stands. `running` is a wake still open (a lane run is
 * queued or running); `failed` is an `error` set; `waiting` is an ended wake whose work
 * lane left the agent's watch, a watch that began during the wake and is still standing
 * (a watch is dropped when the awaited report or the next real run arrives, so only the
 * latest wake can be waiting); otherwise `yielded`.
 */
export function wakeOutcome(
  wake: { startedAt: Date; endedAt: Date | null; error: string | null },
  watchSince: Date | null,
): WakeOutcome {
  if (wake.endedAt === null) {
    return "running";
  }
  if (wake.error !== null) {
    return "failed";
  }
  if (watchSince !== null && watchSince >= wake.startedAt && watchSince <= wake.endedAt) {
    return "waiting";
  }
  return "yielded";
}

/**
 * isActivityTrimmed is true when an ended wake has no activity rows and the agent's oldest
 * activity row is newer than the wake's end: rows age out oldest first, so a wake with
 * none that has nothing older around it lost them. An agent with no activity at all, or a
 * wake with rows, is not trimmed.
 */
export function isActivityTrimmed(args: { endedAt: Date | null; activityRows: number; oldestActivityAt: Date | null }): boolean {
  return (
    args.endedAt !== null &&
    args.activityRows === 0 &&
    args.oldestActivityAt !== null &&
    args.oldestActivityAt.getTime() > args.endedAt.getTime()
  );
}

/** toWakeToolResult cuts a tool result's content to {@link WAKE_RESULT_MAX_CHARS}; `head` is its first characters and `chars` its full length. */
export function toWakeToolResult(args: { head: string; chars: number; isError: boolean }): WakeToolResult {
  return {
    content: args.head.slice(0, WAKE_RESULT_MAX_CHARS),
    is_error: args.isError,
    truncated: args.chars > WAKE_RESULT_MAX_CHARS,
    chars: args.chars,
  };
}

const usageNumber = z.number().default(0);
const responsePayload = z
  .object({
    content: z.array(z.object({ type: z.string() }).passthrough()),
    usage: z
      .object({
        input_tokens: usageNumber,
        output_tokens: usageNumber,
        cache_creation_input_tokens: usageNumber,
        cache_read_input_tokens: usageNumber,
      })
      .passthrough(),
  })
  .passthrough();
const thinkingBlock = z.object({ type: z.literal("thinking"), thinking: z.string() });
const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const toolUseBlock = z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() });

/** A tool result row reduced for a wake detail: its id and the cut result. */
export type WakeResultRow = { logId: string; result: WakeToolResult };

/**
 * toTurnEntry maps one `response` log row to a timeline turn without its `ord`: the lane,
 * usage, joined thinking and text blocks (null when none), and each `tool_use` block paired
 * with its result in `results` by `tool_use_id` (null until the result is logged). Throws
 * `500 internal_error` for a row that is not a response payload.
 */
export function toTurnEntry(
  row: AgentLogRow,
  results: ReadonlyMap<string, WakeResultRow>,
): Omit<Extract<WakeEntry, { type: "turn" }>, "ord"> {
  const parsed = responsePayload.safeParse(row.payload);
  const lane = parseLane(row.lane);
  if (!parsed.success || lane === "router") {
    throw new HathError(500, "internal_error", `log ${row.id} is not a wake response`);
  }
  const thinking: string[] = [];
  const text: string[] = [];
  const calls: WakeToolCall[] = [];
  for (const block of parsed.data.content) {
    const think = thinkingBlock.safeParse(block);
    const say = textBlock.safeParse(block);
    const use = toolUseBlock.safeParse(block);
    if (think.success) {
      thinking.push(think.data.thinking);
    } else if (say.success) {
      text.push(say.data.text);
    } else if (use.success) {
      const found = results.get(use.data.id);
      calls.push({
        id: use.data.id,
        name: use.data.name,
        input: use.data.input,
        log_id: found?.logId ?? null,
        result: found?.result ?? null,
      });
    }
  }
  const { usage } = parsed.data;
  return {
    at: row.createdAt.toISOString(),
    type: "turn",
    lane,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_write: usage.cache_creation_input_tokens,
      cache_read: usage.cache_read_input_tokens,
    },
    thinking: thinking.length > 0 ? thinking.join("\n\n") : null,
    text: text.length > 0 ? text.join("\n\n") : null,
    calls,
  };
}

type Unordered<T> = T extends unknown ? Omit<T, "ord"> : never;

/**
 * orderEntries merges a wake's messages and turns into one timeline and numbers it from 0.
 * Entries sort by their time (millisecond ISO); ties keep the input order, so pass messages
 * in `seq` order and turns in log order: a message precedes a turn of the same millisecond,
 * messages by seq, turns by log time.
 */
export function orderEntries(messages: Unordered<WakeEntry>[], turns: Unordered<WakeEntry>[]): WakeEntry[] {
  return [...messages, ...turns]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((entry, ord) => ({ ...entry, ord }) as WakeEntry);
}
