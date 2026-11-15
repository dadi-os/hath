import assert from "node:assert/strict";
import { test } from "node:test";
import { activityBudgetChars, recallDigestRow, sendRow, siteReadRow, storeRow } from "../src/runtime/activity.js";

test("a store row names each created or changed node with its id and local close", () => {
  const closes = new Date(2026, 10, 14, 23, 59).toISOString();
  const row = storeRow(
    JSON.stringify({
      counts: {},
      operations: [
        { op: "create_node", title: "CSE 300 — Kritik Essay 3 Create", id: "n1", detail: { closes_at: closes } },
        { op: "create_edge", src: "n1", dst: "h1" },
        { op: "update_node", title: "Advising", node_id: "n2" },
        { op: "noop", reason: "nothing" },
      ],
    }),
  );
  assert.equal(row?.kind, "store");
  assert.equal(row?.subject, "CSE 300 — Kritik Essay 3 Create; Advising");
  assert.match(row!.digest, /Kritik Essay 3 Create closes Sat Nov 14 11:59 PM \[n1\]; Advising \[n2\]/);
});

test("an ingest that stored nothing earns no row", () => {
  assert.equal(storeRow(JSON.stringify({ counts: {}, operations: [{ op: "noop", reason: "x" }] })), null);
});

test("a recall by date digests its tasks, those closing that day first", () => {
  const input = { relevant_on: "2026-11-14" };
  const result = JSON.stringify({
    nodes: [
      { kind: "task", title: "HW6", detail: { closes_at: new Date(2026, 10, 20, 23, 59).toISOString() } },
      { kind: "task", title: "Kritik Create", detail: { closes_at: new Date(2026, 10, 14, 23, 59).toISOString() } },
      { kind: "person", title: "Sparsh" },
    ],
  });
  const row = recallDigestRow(input, result);
  assert.equal(row?.kind, "recall_digest");
  assert.equal(row?.digest, "due on 2026-11-14: Kritik Create closes Sat Nov 14 11:59 PM | open: HW6 closes Fri Nov 20 11:59 PM");
  assert.equal(recallDigestRow({}, result), null, "a recall that is not by date is not digested");
  assert.equal(recallDigestRow(input, JSON.stringify({ nodes: [] })), null);
});

test("a browser report is a site read of the hosts the helper navigated, ok only when the helper finished", () => {
  const ok = siteReadRow({ task: "task/browser/3", state: "done", text: "Nothing due.", hosts: ["d2l.msu.edu", "us.kritik.io"] });
  assert.deepEqual([ok.kind, ok.subject], ["site_read", "d2l.msu.edu, us.kritik.io"]);
  assert.match(ok.digest, /^task\/browser\/3 ok: Nothing due/);
  const failed = siteReadRow({ task: "task/browser/4", state: "failed", text: "Sign-in failed", hosts: ["gradescope.com"] });
  assert.equal(failed.subject, "gradescope.com");
  assert.match(failed.digest, /not_read \(failed\)/);
  assert.equal(siteReadRow({ task: "task/browser/5", state: "done", text: "ok", hosts: [] }).subject, "task/browser/5");
  assert.equal(siteReadRow({ task: "task/browser/6", state: "done", text: "Checked gradescope.com", hosts: ["d2l.msu.edu"] }).subject, "d2l.msu.edu", "prose naming a host is not a read of it");
});

test("a send row is the recipient and the start of the message; the list budget is a share of the ceiling", () => {
  assert.deepEqual(sendRow(null, "Nothing is due tonight."), { kind: "send", subject: "ankur", digest: "Nothing is due tonight." });
  assert.equal(sendRow("cse-300-specialist", "x".repeat(300)).digest.length, 161);
  assert.equal(activityBudgetChars(96_000, 0.05), Math.floor(96_000 * 0.05 * 2.3));
});
