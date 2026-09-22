/** Resolve the in-flight tool from durable agent logs for the chat tool preview. */

import type { LogRecord } from "../../shared/api/types";

/** Tool turn-exit name — not shown as a live tool preview. */
const YIELD = "yield";

export type ActiveTool = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Thoughts land before tools run and list every `tool_use` for the round.
 * The first tool_use whose result is not yet logged is the one currently
 * executing (tools run sequentially).
 */
export function findActiveTool(logs: LogRecord[]): ActiveTool | null {
  const completed = new Set<string>();
  for (const log of logs) {
    if (log.event !== "tool_result") {
      continue;
    }
    const id = log.payload.tool_use_id;
    if (typeof id === "string") {
      completed.add(id);
    }
  }

  const chronological = [...logs].reverse();
  for (const log of chronological) {
    if (log.event !== "thought") {
      continue;
    }
    const content = log.payload.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      const row = asRecord(block);
      if (!row || row.type !== "tool_use") {
        continue;
      }
      if (typeof row.id !== "string" || typeof row.name !== "string") {
        continue;
      }
      if (row.name === YIELD) {
        continue;
      }
      if (completed.has(row.id)) {
        continue;
      }
      const input =
        row.input === undefined || row.input === null
          ? {}
          : asRecord(row.input);
      if (input === null) {
        continue;
      }
      return {
        id: row.id,
        name: row.name,
        input,
      };
    }
  }
  return null;
}

function prettyArg(value: unknown, max = 22): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length <= max) {
      return JSON.stringify(trimmed);
    }
    return JSON.stringify(`${trimmed.slice(0, max - 1)}…`);
  }
  return "…";
}

/**
 * Compact `name(key: val, …)` signature for the thread tool preview.
 */
export function formatToolSignature(
  name: string,
  input: Record<string, unknown>,
  maxLen = 64,
): string {
  const keys = Object.keys(input);
  if (keys.length === 0) {
    return `${name}()`;
  }
  const shown = keys.slice(0, 3).map((key) => `${key}: ${prettyArg(input[key])}`);
  const more = keys.length > 3 ? ", …" : "";
  const raw = `${name}(${shown.join(", ")}${more})`;
  if (raw.length <= maxLen) {
    return raw;
  }
  return `${raw.slice(0, maxLen - 1)}…`;
}

/** Lane chip copy from conversation / reasoning occupancy. */
export type LaneChipLabel = "thinking" | "working" | "thinking + working";

/** Lane chip copy from conversation / reasoning occupancy. */
export function laneChipLabel(
  conversation: boolean,
  reasoning: boolean,
): LaneChipLabel | null {
  if (conversation && reasoning) {
    return "thinking + working";
  }
  if (conversation) {
    return "thinking";
  }
  if (reasoning) {
    return "working";
  }
  return null;
}
