import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { attachments } from "../src/db/schema.js";
import { MAX_ATTACHMENT_BYTES, moveLegacyAttachments } from "../src/runtime/attachments.js";
import { assembleContext } from "../src/runtime/context.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import {
  MESSAGE,
  READ_FILE,
  SEND,
} from "../src/types/domain.js";
import {
  insertAgent,
  mockDwar,
  mockGhar,
  mockNas,
  mockYaad,
  openTestDb,
  resetRuntime,
  silentLog,
  testConfig,
  wideWindows,
} from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function harness(nas = mockNas({})) {
  const dwar = mockDwar({});
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas,
    config,
    log: silentLog,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
    yaad: mockYaad(),
    ghar: mockGhar(),
    nas,
    runtime,
  });
  return { dwar, runtime, app };
}

test("POST /messages stores attachments, the transcript shows stubs, and GET /attachments/:id returns the file", async (t) => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { name: "reader", systemPrompt: "reads" });
  const { app, runtime } = await harness();
  t.after(async () => {
    await runtime.waitUntilIdle();
    await app.close();
  });
  const report = "r".repeat(20_000);

  const posted = await app.inject({
    method: "POST",
    url: "/messages",
    payload: {
      to_agent_id: agentId,
      content: "see attached",
      attachments: [
        { media_type: "text/markdown", data: b64(report), filename: "report.md" },
        { media_type: "image/png", data: PNG, filename: "dot.png" },
      ],
    },
  });
  assert.equal(posted.statusCode, 201);
  const sent = posted.json() as { content: string; attachments: Array<{ id: string; filename: string }> };
  assert.equal(sent.content, "see attached");
  assert.deepEqual(
    sent.attachments.map((att) => att.filename),
    ["report.md", "dot.png"],
  );

  const listed = await app.inject({ method: "GET", url: `/agents/${agentId}/messages` });
  const thread = listed.json() as { messages: Array<{ attachments: unknown[] }> };
  assert.equal(thread.messages.at(-1)?.attachments.length, 2);

  const context = await assembleContext({
    windows: wideWindows,
    db: handle.db,
    agentId,
    lane: "process",
    transcript: runtime.transcript,
    serviceRoot: config.serviceRoot,
  });
  const seen = JSON.stringify(context.transcripts.process);
  assert.ok(seen.includes(sent.attachments[0]!.id));
  assert.match(seen, /Path: \/var\/home\/dadi\/\.dadi\/attachments\//, "the block shows the file's path");
  assert.ok(!seen.includes(report), "the contents never enter the transcript");
  assert.ok(seen.includes("mock image description"));

  const file = await app.inject({ method: "GET", url: `/attachments/${sent.attachments[0]!.id}` });
  assert.equal(file.statusCode, 200);
  assert.match(String(file.headers["content-type"]), /^text\/markdown/);
  assert.equal(file.body, report);

  const missing = await app.inject({
    method: "GET",
    url: "/attachments/00000000-0000-4000-8000-000000000000",
  });
  assert.equal(missing.statusCode, 404);
});

test("send with an attachment id copies the carried file's row to the recipient, sharing the one file, and read_file opens it", async (t) => {
  await resetRuntime(handle.sql, handle.db, config);
  const senderId = await insertAgent(handle.db, { name: "sender", systemPrompt: "sends" });
  const recipientId = await insertAgent(handle.db, { name: "recipient", systemPrompt: "gets" });
  const nas = mockNas({});
  const { app, runtime } = await harness(nas);
  t.after(async () => {
    await runtime.waitUntilIdle();
    await app.close();
  });
  const report = "abcdefghij".repeat(3000);
  const posted = await app.inject({
    method: "POST",
    url: "/messages",
    payload: {
      to_agent_id: senderId,
      content: "pass this on",
      attachments: [{ media_type: "text/plain", data: b64(report), filename: "report.txt" }],
    },
  });
  const originalId = (posted.json() as { attachments: Array<{ id: string }> }).attachments[0]!.id;

  const forwarded = await executeTool(runtime.toolContext(senderId, "process"), {
    type: "tool_use",
    id: "f1",
    name: SEND,
    input: { to: recipientId, attachments: [originalId], content: "from Ankur" },
  });
  assert.equal(forwarded.isError, false, forwarded.content);
  const copyId = (JSON.parse(forwarded.content) as { attachments: Array<{ id: string }> }).attachments[0]!.id;
  assert.notEqual(copyId, originalId);
  const rows = await handle.db.select().from(attachments).where(eq(attachments.filename, "report.txt"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.path, rows[1]?.path, "both rows name the same file");
  assert.equal(nas.files.size, 1);

  const received = runtime.transcript.transcriptFor(recipientId).at(-1);
  assert.equal(received?.content, "from Ankur");
  assert.equal(received?.attachments[0]?.id, copyId);

  const page = await executeTool(runtime.toolContext(recipientId, "work"), {
    type: "tool_use",
    id: "r1",
    name: READ_FILE,
    input: { path: received!.attachments[0]!.path, offset: 29_990, limit: 100 },
  });
  assert.equal(page.isError, false, page.content);
  assert.deepEqual(JSON.parse(page.content), {
    path: received!.attachments[0]!.path,
    total_chars: 30_000,
    offset: 29_990,
    next_offset: null,
    content: "abcdefghij",
  });
});

test("send copies a host file path as it is now, and the send binds that same row", async (t) => {
  await resetRuntime(handle.sql, handle.db, config);
  const nas = mockNas({});
  nas.files.set("/var/home/dadi/report.md", Buffer.from("# Title\nbody\n"));
  const workerId = await insertAgent(handle.db, { name: "writer", systemPrompt: "writes" });
  const { app, runtime } = await harness(nas);
  t.after(async () => {
    await runtime.waitUntilIdle();
    await app.close();
  });

  const unknown = await executeTool(runtime.toolContext(workerId, "work"), {
    type: "tool_use",
    id: "s0",
    name: MESSAGE,
    input: { to: "ankur", content: "send it", attachments: ["00000000-0000-4000-8000-000000000000"] },
  });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /^not_found/);

  const sent = await executeTool(runtime.toolContext(workerId, "process"), {
    type: "tool_use",
    id: "f1",
    name: SEND,
    input: { to: "ankur", content: "your report", attachments: ["/var/home/dadi/report.md"] },
  });
  assert.equal(sent.isError, false, sent.content);
  const [row] = await handle.db.select().from(attachments).where(eq(attachments.filename, "report.md"));
  assert.equal(row?.mediaType, "text/markdown");
  assert.equal(nas.files.get(row!.path!)?.toString(), "# Title\nbody\n");
  nas.files.set("/var/home/dadi/report.md", Buffer.from("changed later"));
  assert.equal(nas.files.get(row!.path!)?.toString(), "# Title\nbody\n", "the copy is a snapshot");
  assert.notEqual(row?.messageId, null);
});

test("send gives a Word document and an unlisted binary their media types and keeps their bytes", async (t) => {
  await resetRuntime(handle.sql, handle.db, config);
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe]);
  const nas = mockNas({});
  const workerId = await insertAgent(handle.db, { name: "filer", systemPrompt: "files" });
  const { app, runtime } = await harness(nas);
  t.after(async () => {
    await runtime.waitUntilIdle();
    await app.close();
  });

  const cases = [
    {
      path: "/var/home/dadi/msu/semester-5/ibio-150/work/class-12/filled.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    { path: "/var/home/dadi/scratch/model.onnx", mediaType: "application/octet-stream" },
    { path: "/var/home/dadi/career/Resume.PDF", mediaType: "application/pdf" },
  ];
  for (const [index, { path, mediaType }] of cases.entries()) {
    nas.files.set(path, zipBytes);
    const sent = await executeTool(runtime.toolContext(workerId, "process"), {
      type: "tool_use",
      id: `c${index}`,
      name: SEND,
      input: { to: "ankur", content: `file ${index}`, attachments: [path] },
    });
    assert.equal(sent.isError, false, sent.content);
    const [row] = await handle.db.select().from(attachments).where(eq(attachments.filename, path.split("/").at(-1)!));
    assert.equal(row?.mediaType, mediaType);
    assert.deepEqual(nas.files.get(row!.path!), zipBytes);
  }
  assert.deepEqual(nas.readFileBytesCalls.map((call) => call.max_bytes), [MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES]);
});

test("boot moves attachments that still hold their bytes in the database to files, once", async (t) => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { name: "old", systemPrompt: "old" });
  const id = "00000000-0000-4000-8000-0000000000aa";
  await handle.db.insert(attachments).values({
    id,
    createdByAgentId: agentId,
    position: 0,
    filename: "old.txt",
    mediaType: "text/plain",
    sizeBytes: 3,
    textContent: "old",
  });
  const nas = mockNas({});
  const { app, runtime } = await harness(nas);
  t.after(async () => {
    await runtime.waitUntilIdle();
    await app.close();
  });

  assert.equal(await moveLegacyAttachments(handle.db, runtime.files), 1);
  const [row] = await handle.db.select().from(attachments).where(eq(attachments.id, id));
  assert.equal(row?.path, `${config.files.dir}/attachments/${id}/old.txt`);
  assert.equal(row?.textContent, null);
  assert.equal(nas.files.get(row!.path!)?.toString(), "old");
  assert.equal(await moveLegacyAttachments(handle.db, runtime.files), 0);
});
