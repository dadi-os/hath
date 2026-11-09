import assert from "node:assert/strict";
import { test } from "node:test";
import { logEntrySchema } from "../src/nas/client.js";

const base = { seq: 1, at: "2026-11-09T10:00:00Z", agent: "career-manager" };
const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };

test("logEntrySchema accepts each entry type Nas writes", () => {
  const entries = [
    { ...base, type: "steer", from: "career-manager", message: "fill the form", held: false, start: true },
    { ...base, type: "turn", ms: 900, stop_reason: "tool_use", usage, thinking: "", text: "ok", calls: [{ id: "c1", name: "click", input: { ref: "e3" } }] },
    { ...base, type: "result", tool_use_id: "c1", name: "click", is_error: false, chars: 12, head: "clicked", ms: 40 },
    { ...base, type: "state", status: "idle", reason: "done" },
    { ...base, type: "report", state: "done", text: "finished", files: ["/a.pdf"] },
  ];
  for (const entry of entries) {
    assert.deepEqual(logEntrySchema.parse(entry), entry);
  }
});

test("logEntrySchema rejects an unknown type and an entry missing its fields", () => {
  assert.equal(logEntrySchema.safeParse({ ...base, type: "mystery" }).success, false);
  assert.equal(logEntrySchema.safeParse({ ...base, type: "state", status: "idle" }).success, false);
});
