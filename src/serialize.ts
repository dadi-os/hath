/** Map Drizzle agent/log/scheduled-message rows to API snake_case records. */

import type { AgentLogRow, AgentRow, ScheduledMessageRow } from "./db/schema.js";
import type {
  AgentRecord,
  LogEvent,
  LogRecord,
  Lane,
  ScheduledMessageRecord,
} from "./types/domain.js";
import { HathError } from "./errors.js";

function parseLane(value: string): Lane {
  if (value === "work" || value === "process" || value === "router") {
    return value;
  }
  throw new HathError(500, "internal_error", `invalid lane in database: ${value}`);
}

function parseLogEvent(value: string): LogEvent {
  if (
    value === "response" ||
    value === "tool_result" ||
    value === "message"
  ) {
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
