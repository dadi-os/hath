import assert from "node:assert/strict";
import { test } from "node:test";
import { boxLink, inboxFolder } from "../src/runtime/box-link.js";

test("boxLink encodes each segment as the clients do, and escapes brackets in the name", () => {
  assert.equal(boxLink("/var/home/dadi/School/hw3.pdf"), "[hw3.pdf](box:///var/home/dadi/School/hw3.pdf)");
  assert.equal(
    boxLink("/var/home/dadi/Inbox/2026-11/Résumé (final) [v2] 100%.pdf"),
    "[Résumé (final) \\[v2\\] 100%.pdf](box:///var/home/dadi/Inbox/2026-11/R%C3%A9sum%C3%A9%20%28final%29%20%5Bv2%5D%20100%25.pdf)",
  );
  assert.equal(boxLink("/a/it's!~*.txt"), "[it's!~*.txt](box:///a/it's!~*.txt)");
});

test("the Inbox folder is the month of the date, zero-padded", () => {
  assert.equal(inboxFolder(new Date(2026, 10, 26, 9, 30)), "/var/home/dadi/Inbox/2026-11");
  assert.equal(inboxFolder(new Date(2027, 0, 2)), "/var/home/dadi/Inbox/2027-01");
});
