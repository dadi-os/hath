import assert from "node:assert/strict";
import { test } from "node:test";
import { fileKey, firstOfEachFile } from "../src/db/attachments.js";

test("firstOfEachFile keeps one entry per content hash, the first, whatever the names", () => {
  const kept = firstOfEachFile([
    { name: "queued", contentSha256: "aa", path: "/files/1/a.md" },
    { name: "sent", contentSha256: "aa", path: "/files/2/a.md" },
    { name: "other", contentSha256: "bb", path: "/files/3/a.md" },
  ]);
  assert.deepEqual(kept.map((file) => file.name), ["queued", "other"]);
});

test("firstOfEachFile keeps files that share a name but not content", () => {
  const kept = firstOfEachFile([
    { contentSha256: "aa", path: "/files/1/image.png" },
    { contentSha256: "bb", path: "/files/2/image.png" },
  ]);
  assert.equal(kept.length, 2);
});

test("a row without a hash is the same file as another row at its path, and no other", () => {
  assert.equal(fileKey({ contentSha256: null, path: "/files/1/a.md" }), fileKey({ contentSha256: null, path: "/files/1/a.md" }));
  assert.notEqual(fileKey({ contentSha256: null, path: "/files/1/a.md" }), fileKey({ contentSha256: null, path: "/files/2/a.md" }));
  assert.notEqual(fileKey({ contentSha256: null, path: "/files/1/a.md" }), fileKey({ contentSha256: "aa", path: "/files/1/a.md" }));
});
