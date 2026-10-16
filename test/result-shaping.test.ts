import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/runtime/tools.js";
import { stepActions } from "../src/runtime/record.js";
import { CLEARED_PREFIX, receipt } from "../src/runtime/wake.js";
import { shapeGrep } from "../src/tools/terminal/grep.js";
import { shapeRead } from "../src/tools/terminal/read-file.js";

const matches = [
  { path: "/home/a.ts", line: 3, text: "const wait = 1;" },
  { path: "/home/a.ts", line: 9, text: "wait(wait);" },
  { path: "/home/b.ts", line: 1, text: "x".repeat(500) },
];

test("grep lists each matching file once by default, with counts on request", () => {
  assert.equal(shapeGrep("files_with_matches", { matches, truncated: false }), "3 matches in 2 files\n/home/a.ts\n/home/b.ts");
  assert.equal(shapeGrep("count", { matches, truncated: true }).split("\n").slice(0, 3).join("\n"), "3 matches in 2 files\n2\t/home/a.ts\n1\t/home/b.ts");
  assert.match(shapeGrep("count", { matches, truncated: true }), /more matches exist/);
  assert.equal(shapeGrep("content", { matches: [], truncated: false }), "No matches.");
});

test("grep content groups lines under their file and clips an over-long line", () => {
  const shown = shapeGrep("content", { matches, truncated: false });
  assert.match(shown, /^3 matches\n\/home\/a\.ts\n {2}3: const wait = 1;\n {2}9: wait\(wait\);\n\/home\/b\.ts\n {2}1: x{300}… \(500 chars\)$/);
});

test("a read that stops early says where and the offset that continues it", () => {
  assert.equal(shapeRead({ content: "1\ta\n2\tb\n", total_lines: 2, truncated: false }, 1), "1\ta\n2\tb");
  assert.equal(
    shapeRead({ content: "5\te\n6\tf\n", total_lines: 40, truncated: true }, 5),
    "5\te\n6\tf\n(lines through 6 of 40 shown; continue with offset 7)",
  );
  assert.match(shapeRead({ content: "", total_lines: 40, truncated: true }, 12), /line 12 alone is longer than max_bytes/);
});

test("a receipt names the call, its size, how it began and the id that reopens it", () => {
  const note = receipt(CLEARED_PREFIX, "toolu_1", { name: "terminal_read_file", input: { path: "/x.md" } }, "1\t# Title\n2\tbody ".repeat(100));
  assert.match(note, /^\[cleared\] terminal_read_file \{"path":"\/x\.md"\} · 1700 chars, out of view\. read_result toolu_1 reopens it/);
  assert.match(note, /Began: 1 # Title 2 body/);
  assert.equal(note, receipt(CLEARED_PREFIX, "toolu_1", { name: "terminal_read_file", input: { path: "/x.md" } }, "1\t# Title\n2\tbody ".repeat(100)), "the same bytes every time");
});

test("a record shows a long read by its size and id, a short one whole, and leaves sends out", () => {
  const record = stepActions(
    [
      { type: "text", text: "Reading the plan." },
      { type: "tool_use", id: "r1", name: "terminal_read_file", input: { path: "/plan.md" } },
      { type: "tool_use", id: "r2", name: "terminal_glob", input: { pattern: "*.md" } },
      { type: "tool_use", id: "s1", name: "send_message", input: { to_agent_id: null, content: "hi" } },
    ],
    new Map([
      ["r1", { content: "x".repeat(400), chars: 9_000, is_error: false }],
      ["r2", { content: "/plan.md", is_error: false }],
      ["s1", { content: "{}", is_error: false }],
    ]),
  );
  assert.equal(
    record,
    'Reading the plan.\n  terminal_read_file {"path":"/plan.md"} → read 9000 chars (read_result r1)\n  terminal_glob {"pattern":"*.md"} → /plan.md',
  );
  assert.equal(stepActions([{ type: "tool_use", id: "r1", name: "terminal_read_file", input: {} }], new Map(), true), null, "a trimmed note lists actions only");
});
