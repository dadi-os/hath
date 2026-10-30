import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/runtime/tools.js";
import { stepActions } from "../src/runtime/record.js";
import { CLEARED_PREFIX, receipt } from "../src/runtime/wake.js";
import { shapeMatches } from "../src/tools/files/files.js";

const matches = [
  { path: "/home/a.ts", line: 3, text: "const wait = 1;" },
  { path: "/home/a.ts", line: 9, text: "wait(wait);" },
  { path: "/home/b.ts", line: 1, text: "x".repeat(500) },
];

test("find lists matching lines under their file and clips an over-long line", () => {
  assert.equal(shapeMatches({ matches: [], truncated: false }), "No matches.");
  const shown = shapeMatches({ matches, truncated: false });
  assert.match(shown, /^3 matches\n\/home\/a\.ts\n {2}3: const wait = 1;\n {2}9: wait\(wait\);\n\/home\/b\.ts\n {2}1: x{300}… \(500 chars\)$/);
  assert.match(shapeMatches({ matches, truncated: true }), /more matches exist/);
});

const body = "1\t# Title\n2\tbody ".repeat(100);

test("a receipt names the call, its size, how it began and the file holding the whole result", () => {
  const call = { name: "web_fetch", input: { urls: ["https://x.example/"] } };
  const note = receipt(CLEARED_PREFIX, "toolu_1", call, body, "/files");
  assert.match(note, /^\[cleared\] web_fetch \{"urls":\["https:\/\/x\.example\/"\]\} · 1700 chars, out of view\. Saved at \/files\/results\/toolu_1\.txt: read_file it/);
  assert.match(note, /Began: 1 # Title 2 body/);
  assert.equal(note, receipt(CLEARED_PREFIX, "toolu_1", call, body, "/files"), "the same bytes every time");
});

test("a receipt for a read_file result says to run it again, since no file holds it", () => {
  const note = receipt(CLEARED_PREFIX, "toolu_2", { name: "read_file", input: { path: "/x.md" } }, body, "/files");
  assert.match(note, /Run it again to see it\./);
  assert.doesNotMatch(note, /Saved at/);
});

test("a record shows a long read by its size and file, a short one whole, and leaves sends out", () => {
  const record = stepActions(
    [
      { type: "text", text: "Reading the plan." },
      { type: "tool_use", id: "r1", name: "web_fetch", input: { urls: ["https://p.example/"] } },
      { type: "tool_use", id: "r2", name: "find", input: { name: "*.md" } },
      { type: "tool_use", id: "s1", name: "send", input: { to: "ankur", content: "hi" } },
    ],
    new Map([
      ["r1", { content: "x".repeat(400), chars: 9_000, is_error: false }],
      ["r2", { content: "/plan.md", is_error: false }],
      ["s1", { content: "{}", is_error: false }],
    ]),
    "/files",
  );
  assert.equal(
    record,
    'Reading the plan.\n  web_fetch {"urls":["https://p.example/"]} → read 9000 chars, saved at /files/results/r1.txt\n  find {"name":"*.md"} → /plan.md',
  );
  assert.equal(stepActions([{ type: "tool_use", id: "r1", name: "read_file", input: {} }], new Map(), "/files", true), null, "a trimmed note lists actions only");
});

test("web_search shows one line per result and web_fetch shows answers while storing every page whole", async () => {
  const { webFetch, webSearch } = await import("../src/tools/web/web.js");
  const dwar = {
    webSearch: async () => ({
      searches: 1,
      results: [
        { title: "Registrar calendar", url: "https://reg.msu.edu/cal", page_age: "48 days ago", about: "Lists Fall 2026 drop dates." },
        { title: "Forum thread", url: "https://forum.example/t/1", page_age: null, about: null },
      ],
    }),
    webFetch: async () => ({
      pages: [
        { url: "https://reg.msu.edu/cal", final_url: "https://reg.msu.edu/cal", status: 200, title: "Calendar", text: "Fall 2026\nLast day to drop with no grade: Sept 9.\n" + "x".repeat(5_000), error: null, answer: "\"Last day to drop with no grade: Sept 9.\"" },
        { url: "https://example.com/a.pdf", final_url: "https://example.com/a.pdf", status: 200, title: "", text: "", error: "not a text page (application/pdf)", answer: null },
      ],
    }),
  };
  const ctx = { callerId: "cse-431-specialist", dwar, callId: "call-9", files: { dir: "/files" } } as never;

  const searched = await webSearch.handler(ctx, { query: "msu drop deadline fall 2026" });
  assert.equal(searched.isError, false);
  assert.equal(
    searched.content,
    '2 results for "msu drop deadline fall 2026"\n1. Registrar calendar — https://reg.msu.edu/cal (48 days ago)\n   Lists Fall 2026 drop dates.\n2. Forum thread — https://forum.example/t/1',
  );

  const fetched = await webFetch.handler(ctx, { urls: ["https://reg.msu.edu/cal", "https://example.com/a.pdf"], question: "When is the last no-grade drop day?" });
  assert.equal(fetched.isError, false);
  assert.match(fetched.content, /^1 of 2 pages read, each answering: When is the last no-grade drop day\?/);
  assert.match(fetched.content, /saved at \/files\/results\/call-9\.txt: read_file reads or searches it/);
  assert.match(fetched.content, /1\. Calendar — https:\/\/reg\.msu\.edu\/cal · \d+ chars\n {3}"Last day to drop with no grade: Sept 9\."/);
  assert.match(fetched.content, /2\. https:\/\/example\.com\/a\.pdf\n {3}failed: not a text page/);
  assert.ok(fetched.content.length < 700, "the prompt sees answers, never pages");
  assert.match(String(fetched.audit.full), /=== 1\. https:\/\/reg\.msu\.edu\/cal — Calendar\nFall 2026\nLast day to drop/);
});
