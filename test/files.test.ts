import assert from "node:assert/strict";
import { test } from "node:test";
import { editFile, findFiles, readFile, writeFile } from "../src/tools/files/files.js";
import type { ToolContext } from "../src/tools/shared.js";
import { mockDwar, mockNas } from "./helpers.js";

function setup(nasOpts: Parameters<typeof mockNas>[0] = {}) {
  const nas = mockNas(nasOpts);
  const dwar = mockDwar({});
  const ctx = { nas, dwar, callerId: "a1", files: { nas, dir: "/files" } } as unknown as ToolContext;
  return { nas, dwar, ctx };
}

const put = (nas: ReturnType<typeof mockNas>, path: string, content: string | Buffer) =>
  nas.files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content));

test("read_file pages a text file by characters and says where the next page starts", async () => {
  const { nas, ctx } = setup();
  put(nas, "/home/notes.md", "abcdefghij");
  const first = JSON.parse((await readFile.handler(ctx, { path: "/home/notes.md", limit: 4 })).content);
  assert.deepEqual(first, { path: "/home/notes.md", total_chars: 10, offset: 0, next_offset: 4, content: "abcd" });
  const last = JSON.parse((await readFile.handler(ctx, { path: "/home/notes.md", offset: 8, limit: 4 })).content);
  assert.equal(last.content, "ij");
  assert.equal(last.next_offset, null);
});

test("read_file with a pattern returns the matching lines with their numbers", async () => {
  const { nas, ctx } = setup();
  put(nas, "/home/log.txt", "start\nERROR one\nok\nerror two\n");
  const found = JSON.parse((await readFile.handler(ctx, { path: "/home/log.txt", pattern: "error" })).content);
  assert.equal(found.matches, 2);
  assert.equal(found.lines, "2: ERROR one\n4: error two");
  const bad = await readFile.handler(ctx, { path: "/home/log.txt", pattern: "(" });
  assert.equal(bad.isError, true);
});

test("read_file describes an image with Dwar and refuses other binary files", async () => {
  const { nas, dwar, ctx } = setup();
  put(nas, "/home/shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  const image = JSON.parse((await readFile.handler(ctx, { path: "/home/shot.png" })).content);
  assert.equal(image.kind, "image");
  assert.equal(image.description, "mock image description");
  assert.equal(dwar.describeCalls[0]?.image.media_type, "image/png");

  put(nas, "/home/blob.bin", Buffer.from([0, 255, 0, 1]));
  const binary = await readFile.handler(ctx, { path: "/home/blob.bin" });
  assert.equal(binary.isError, true);
  assert.match(binary.content, /^binary_file: /);
});

test("read_file turns a PDF into text once with pdftotext and reads the cached text after", async () => {
  const { nas, ctx } = setup({
    exec: () => ({ exit_code: 0, output: "", truncated: false, timed_out: false }),
  });
  const pdf = Buffer.from("%PDF-1.7 pretend");
  put(nas, "/home/paper.pdf", pdf);
  const failed = await readFile.handler(ctx, { path: "/home/paper.pdf" });
  assert.match(failed.content, /^not_found: /, "the mock pdftotext wrote no file");

  const textPath = nas.execCalls[0]!.body.command.match(/ '(\/files\/pdf\/[0-9a-f]{40}\.txt)'$/)?.[1];
  assert.ok(textPath, "pdftotext writes under the files folder, named by the PDF's contents");
  assert.match(nas.execCalls[0]!.body.command, /^mkdir -p '\/files\/pdf' && pdftotext -layout '\/home\/paper\.pdf' /);
  assert.deepEqual(nas.terminalsCreated, nas.terminalsClosed, "the terminal it opened is closed");

  put(nas, textPath, "Page one text\n");
  const read = JSON.parse((await readFile.handler(ctx, { path: "/home/paper.pdf" })).content);
  assert.equal(read.content, "Page one text\n");
  assert.equal(nas.execCalls.length, 1, "the second read uses the cached text");
});

test("a PDF that pdftotext cannot read is a tool error naming the exit", async () => {
  const { nas, ctx } = setup({ exec: () => ({ exit_code: 127, output: "pdftotext: not found", truncated: false, timed_out: false }) });
  put(nas, "/home/paper.pdf", Buffer.from("%PDF-1.7"));
  const result = await readFile.handler(ctx, { path: "/home/paper.pdf" });
  assert.equal(result.isError, true);
  assert.match(result.content, /failed \(exit 127\): pdftotext: not found/);
  assert.equal(nas.terminalsClosed.length, 1);
});

test("read_file on a missing file is a tool error with Nas's type", async () => {
  const { ctx } = setup();
  const result = await readFile.handler(ctx, { path: "/home/none.txt" });
  assert.equal(result.isError, true);
  assert.match(result.content, /^not_found: /);
});

test("find by name searches at any depth unless the name has a slash", async () => {
  const { nas, ctx } = setup({ glob: () => ({ paths: ["/h/a.md", "/h/x/b.md"], truncated: false }) });
  const found = await findFiles.handler(ctx, { name: "*.md", path: "/h" });
  assert.equal(found.content, "2 files\n/h/a.md\n/h/x/b.md");
  assert.deepEqual(nas.globCalls[0], { pattern: "**/*.md", cwd: "/h", limit: 200 });
  await findFiles.handler(ctx, { name: "notes/*.md" });
  assert.equal(nas.globCalls[1]?.pattern, "notes/*.md");
});

test("find by text greps, filtered by name when both are given, and shows numbered lines", async () => {
  const { nas, ctx } = setup({
    grep: () => ({ matches: [{ path: "/h/tracker.json", line: 40, text: '  "name": "Priya Shah",' }], truncated: false }),
  });
  const found = await findFiles.handler(ctx, { text: "Priya", name: "*.json" });
  assert.equal(found.content, '1 matches\n/h/tracker.json\n  40:   "name": "Priya Shah",');
  assert.deepEqual(nas.grepCalls[0], { pattern: "Priya", glob: "*.json", limit: 100 });
  assert.equal(findFiles.input.safeParse({}).success, false, "name or text is required");
});

test("write_file creates a file and edit_file replaces one exact piece of it", async () => {
  const { nas, ctx } = setup();
  const written = JSON.parse((await writeFile.handler(ctx, { path: "/h/due.txt", content: "a\nb\nc\n" })).content);
  assert.deepEqual(written, { path: "/h/due.txt", bytes: 6 });
  const edited = await editFile.handler(ctx, { path: "/h/due.txt", old: "b", new: "B" });
  assert.equal(edited.isError, false);
  assert.equal(nas.files.get("/h/due.txt")?.toString(), "a\nB\nc\n");
});

test("edit_file fails and leaves the file alone when old is missing or occurs twice", async () => {
  const { nas, ctx } = setup();
  put(nas, "/h/f.txt", "x y x");
  const twice = await editFile.handler(ctx, { path: "/h/f.txt", old: "x", new: "z" });
  assert.equal(twice.isError, true);
  assert.match(twice.content, /^conflict: .*2 times/);
  const none = await editFile.handler(ctx, { path: "/h/f.txt", old: "q", new: "z" });
  assert.equal(none.isError, true);
  assert.match(none.content, /^conflict: .*0 times/);
  assert.equal(nas.files.get("/h/f.txt")?.toString(), "x y x");
  assert.equal(editFile.input.safeParse({ path: "/h/f.txt", old: "", new: "z" }).success, false);
  assert.equal(writeFile.input.safeParse({ path: "relative", content: "" }).success, false);
});
