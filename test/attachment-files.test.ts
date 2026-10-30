import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { HathError } from "../src/errors.js";
import { attachmentStub, prepareUploads, textAttachment } from "../src/runtime/attachments.js";
import { attachmentPath, resultPath, safeName } from "../src/runtime/files.js";
import { mockDwar, mockNas } from "./helpers.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

test("prepareUploads writes each file to the box under its own id and describes images", async () => {
  const nas = mockNas();
  const dwar = mockDwar({});
  const prepared = await prepareUploads({ dwar, files: { nas, dir: "/files" } }, [
    { media_type: "text/markdown", data: b64("# Report\n"), filename: "report.md" },
    { media_type: "image/png", data: PNG, filename: "dot.png" },
    { media_type: "application/pdf", data: b64("%PDF-1.4"), filename: "notes.pdf" },
  ]);

  assert.equal(dwar.describeCalls.length, 1);
  assert.deepEqual(prepared.map((file) => file.path), prepared.map((file) => `/files/attachments/${file.id}/${file.filename}`));
  assert.equal(nas.files.get(prepared[0]!.path)?.toString(), "# Report\n");
  assert.deepEqual(nas.files.get(prepared[1]!.path), Buffer.from(PNG, "base64"));
  assert.equal(prepared[1]?.description, "mock image description");
  assert.equal(prepared[2]?.description, null);
  assert.equal(prepared[2]?.sizeBytes, 8);
});

test("prepareUploads rejects a text file that is not UTF-8 and writes nothing", async () => {
  const nas = mockNas();
  await assert.rejects(
    prepareUploads({ dwar: mockDwar({}), files: { nas, dir: "/files" } }, [
      { media_type: "text/plain", data: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64") },
    ]),
    (err: unknown) => err instanceof HathError && err.statusCode === 422,
  );
  assert.equal(nas.files.size, 0);
});

test("an attachment's stub shows its path, an image's description, and how to open it", () => {
  const base = { id: "00000000-0000-4000-8000-000000000001", filename: "f.txt", mediaType: "text/plain", sizeBytes: 2048, description: null, path: "/files/attachments/x/f.txt" };
  const text = attachmentStub(base);
  assert.match(text, /^\[Attachment 00000000-0000-4000-8000-000000000001 · f\.txt · text\/plain · 2 KB\]\nPath: \/files\/attachments\/x\/f\.txt\n/);
  assert.match(text, /read_file/);
  assert.match(attachmentStub({ ...base, mediaType: "image/png", description: "a dot" }), /\na dot\n/);
});

test("file names cannot leave their folder", () => {
  assert.equal(safeName("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(safeName(".."), "file");
  assert.equal(attachmentPath("/files", "id1", "a/b.txt"), "/files/attachments/id1/a_b.txt");
  assert.equal(resultPath("/files", "toolu_01/x"), "/files/results/toolu_01_x.txt");
});

test("an oversized message is stored whole as a text file", async () => {
  const nas = mockNas();
  const stored = await textAttachment({ nas, dir: "/files" }, "message.md", "text/markdown", "long ".repeat(10));
  assert.equal(nas.files.get(stored.path)?.toString(), "long ".repeat(10));
  assert.equal(stored.sizeBytes, 50);
});
