import assert from "node:assert/strict";
import { test } from "node:test";
import { boxLink, inboxFolder } from "../src/runtime/box-link.js";
import { linkUploads, type MessageUpload } from "../src/runtime/inbox.js";
import { HathError } from "../src/errors.js";
import { mockNas } from "./helpers.js";

const NOW = new Date(2026, 10, 26, 9, 30);

function upload(text: string, filename?: string, mediaType = "application/pdf"): MessageUpload {
  return { media_type: mediaType, data: Buffer.from(text).toString("base64"), ...(filename !== undefined ? { filename } : {}) };
}

test("boxLink encodes each segment as the clients do, and escapes brackets in the name", () => {
  assert.equal(boxLink("/var/home/dadi/msu/hw3.pdf"), "[hw3.pdf](box:///var/home/dadi/msu/hw3.pdf)");
  assert.equal(
    boxLink("/var/home/dadi/Inbox/2026-11/Résumé (final) [v2] 100%.pdf"),
    "[Résumé (final) \\[v2\\] 100%.pdf](box:///var/home/dadi/Inbox/2026-11/R%C3%A9sum%C3%A9%20%28final%29%20%5Bv2%5D%20100%25.pdf)",
  );
  assert.equal(boxLink("/a/it's!~*.txt"), "[it's!~*.txt](box:///a/it's!~*.txt)");
});

test("the Inbox folder is the month of the date, zero-padded", () => {
  assert.equal(inboxFolder(NOW), "/var/home/dadi/Inbox/2026-11");
  assert.equal(inboxFolder(new Date(2027, 0, 2)), "/var/home/dadi/Inbox/2027-01");
});

test("uploads land in the Inbox without overwriting and are linked after the text", async () => {
  const nas = mockNas();
  nas.files.set("/var/home/dadi/Inbox/2026-11/cv.pdf", Buffer.from("old"));

  const content = await linkUploads(nas, "my cv", [upload("new", "cv.pdf"), upload("x"), upload("y", "a/b.txt", "text/plain")], NOW);

  assert.equal(
    content,
    [
      "my cv",
      "",
      "[cv (2).pdf](box:///var/home/dadi/Inbox/2026-11/cv%20%282%29.pdf)",
      "[attachment-2](box:///var/home/dadi/Inbox/2026-11/attachment-2)",
      "[a_b.txt](box:///var/home/dadi/Inbox/2026-11/a_b.txt)",
    ].join("\n"),
  );
  assert.equal(nas.files.get("/var/home/dadi/Inbox/2026-11/cv.pdf")?.toString(), "old");
  assert.equal(nas.files.get("/var/home/dadi/Inbox/2026-11/cv (2).pdf")?.toString(), "new");
});

test("a message of files alone is just their links, and no files leaves the text as it was", async () => {
  const nas = mockNas();
  assert.equal(await linkUploads(nas, "", [upload("x", "one.pdf")], NOW), "[one.pdf](box:///var/home/dadi/Inbox/2026-11/one.pdf)");
  assert.equal(await linkUploads(nas, "plain", [], NOW), "plain");
  assert.equal(nas.uploadFileCalls.length, 1);
});

test("bad uploads are a 422 naming the file and nothing after it is written", async () => {
  const nas = mockNas();
  await assert.rejects(
    linkUploads(nas, "", [upload("ok", "ok.pdf"), { media_type: "application/pdf", data: "not base64!" }], NOW),
    (err: unknown) => err instanceof HathError && err.statusCode === 422 && /attachments\[1\]\.data is not valid base64/.test(err.message),
  );
  await assert.rejects(
    linkUploads(nas, "", [{ media_type: "text/plain", data: Buffer.from([0xff, 0xfe, 0xfd, 0xfc]).toString("base64") }], NOW),
    /not valid UTF-8 text/,
  );
  await assert.rejects(linkUploads(nas, "", Array.from({ length: 9 }, () => upload("x")), NOW), /exceeds max of 8/);
  assert.equal(nas.uploadFileCalls.length, 1, "only the file before the bad one was written");
});
