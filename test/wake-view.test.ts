import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentLogRow } from "../src/db/schema.js";
import {
  isActivityTrimmed,
  orderEntries,
  toTurnEntry,
  toWakeToolResult,
  wakeOutcome,
  WAKE_RESULT_MAX_CHARS,
} from "../src/serialize.js";

const at = (iso: string) => new Date(iso);
const started = at("2026-11-08T10:00:00.000Z");
const ended = at("2026-11-08T10:05:00.000Z");

test("a wake still open is running, even beside a watch", () => {
  assert.equal(wakeOutcome({ startedAt: started, endedAt: null, error: null }, at("2026-11-08T10:01:00.000Z")), "running");
});

test("an ended wake with an error is failed, whatever else holds", () => {
  assert.equal(wakeOutcome({ startedAt: started, endedAt: ended, error: "boom" }, at("2026-11-08T10:01:00.000Z")), "failed");
});

test("an ended wake is waiting only when a watch began during it", () => {
  const wake = { startedAt: started, endedAt: ended, error: null };
  assert.equal(wakeOutcome(wake, at("2026-11-08T10:04:59.000Z")), "waiting");
  assert.equal(wakeOutcome(wake, at("2026-11-08T09:00:00.000Z")), "yielded");
  assert.equal(wakeOutcome(wake, at("2026-11-08T11:00:00.000Z")), "yielded");
  assert.equal(wakeOutcome(wake, null), "yielded");
});

test("activity is trimmed only for an ended wake with no rows and nothing older around it", () => {
  const later = at("2026-11-09T00:00:00.000Z");
  assert.equal(isActivityTrimmed({ endedAt: ended, activityRows: 0, oldestActivityAt: later }), true);
  assert.equal(isActivityTrimmed({ endedAt: ended, activityRows: 3, oldestActivityAt: later }), false);
  assert.equal(isActivityTrimmed({ endedAt: ended, activityRows: 0, oldestActivityAt: started }), false);
  assert.equal(isActivityTrimmed({ endedAt: ended, activityRows: 0, oldestActivityAt: null }), false);
  assert.equal(isActivityTrimmed({ endedAt: null, activityRows: 0, oldestActivityAt: later }), false);
});

test("a tool result over the cap is cut and says so, with its full length", () => {
  const whole = toWakeToolResult({ head: "x".repeat(WAKE_RESULT_MAX_CHARS), chars: WAKE_RESULT_MAX_CHARS, isError: false });
  assert.deepEqual([whole.truncated, whole.chars, whole.content.length], [false, WAKE_RESULT_MAX_CHARS, WAKE_RESULT_MAX_CHARS]);
  const cut = toWakeToolResult({ head: "x".repeat(WAKE_RESULT_MAX_CHARS), chars: WAKE_RESULT_MAX_CHARS + 500, isError: true });
  assert.deepEqual([cut.truncated, cut.chars, cut.is_error], [true, WAKE_RESULT_MAX_CHARS + 500, true]);
});

function responseRow(payload: Record<string, unknown>, lane = "work"): AgentLogRow {
  return {
    id: "a1f0c0de-0000-4000-8000-000000000001",
    agentId: "agent-1",
    lane,
    event: "response",
    payload,
    wakeId: "0b6f7d5e-6a0c-4b1e-9a43-2f1d7c3a1001",
    createdAt: at("2026-11-08T10:00:01.000Z"),
  };
}

test("a turn pairs each tool call with its result and null until one is logged", () => {
  const row = responseRow({
    content: [
      { type: "thinking", thinking: "plan" },
      { type: "redacted_thinking", data: "zzz" },
      { type: "text", text: "going" },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "/a" } },
      { type: "tool_use", id: "t2", name: "web_search", input: { query: "q" } },
    ],
    usage: { input_tokens: 4, output_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
  });
  const result = toWakeToolResult({ head: "ok", chars: 2, isError: false });
  const turn = toTurnEntry(row, new Map([["t1", { logId: "log-1", result }]]));
  assert.deepEqual(turn.usage, { input_tokens: 4, output_tokens: 9, cache_write: 100, cache_read: 200 });
  assert.equal(turn.thinking, "plan");
  assert.equal(turn.text, "going");
  assert.deepEqual(turn.calls, [
    { id: "t1", name: "read_file", input: { path: "/a" }, log_id: "log-1", result },
    { id: "t2", name: "web_search", input: { query: "q" }, log_id: null, result: null },
  ]);
});

test("a turn with no thinking or text reports null, and usage a provider omits counts as zero", () => {
  const turn = toTurnEntry(responseRow({ content: [], usage: { input_tokens: 1, output_tokens: 2 } }, "process"), new Map());
  assert.deepEqual([turn.thinking, turn.text, turn.lane, turn.usage.cache_read], [null, null, "process", 0]);
});

test("a row that is not a response payload is a 500 internal_error", () => {
  assert.throws(() => toTurnEntry(responseRow({ nothing: true }), new Map()), { statusCode: 500, type: "internal_error" });
});

test("entries are ordered by time with a message before a turn of the same millisecond, numbered from 0", () => {
  const message = (iso: string, seq: number) =>
    ({
      at: iso,
      type: "message" as const,
      direction: "received" as const,
      message: { id: String(seq), seq, kind: "message" as const, status: null, from_agent_id: null, to_agent_id: "a", content: "", created_at: iso, attachments: [] },
    });
  const turn = (iso: string) => ({
    at: iso,
    type: "turn" as const,
    lane: "work" as const,
    usage: { input_tokens: 0, output_tokens: 0, cache_write: 0, cache_read: 0 },
    thinking: null,
    text: null,
    calls: [],
  });
  const entries = orderEntries(
    [message("2026-11-08T10:00:02.000Z", 7), message("2026-11-08T10:00:02.000Z", 8), message("2026-11-08T10:00:05.000Z", 9)],
    [turn("2026-11-08T10:00:01.000Z"), turn("2026-11-08T10:00:02.000Z")],
  );
  assert.deepEqual(
    entries.map((entry) => [entry.ord, entry.type, entry.type === "message" ? entry.message.seq : null]),
    [
      [0, "turn", null],
      [1, "message", 7],
      [2, "message", 8],
      [3, "turn", null],
      [4, "message", 9],
    ],
  );
});
