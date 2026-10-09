import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { INLINE_TEXT_CHARS, type AttachmentMeta } from "../src/db/attachments.js";
import { migrate } from "../src/db/migrate.js";
import { attachments } from "../src/db/schema.js";
import { HathError } from "../src/errors.js";
import { attachmentStub, prepareUploads } from "../src/runtime/attachments.js";
import { assembleContext } from "../src/runtime/context.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import {
  CREATE_ATTACHMENT,
  FORWARD_ATTACHMENT,
  READ_ATTACHMENT,
  SEND_MESSAGE,
} from "../src/types/domain.js";
import {
  insertWorker,
  mockChaavi,
  mockDwar,
  mockGhar,
  mockNas,
  mockYaad,
  openTestDb,
  resetRuntime,
  silentLog,
  testConfig,
  wideWindow,
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

function meta(overrides: Partial<AttachmentMeta>): AttachmentMeta {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    filename: "f",
    mediaType: "text/plain",
    sizeBytes: 1,
    description: null,
    textLength: null,
    textHead: null,
    ...overrides,
  };
}

async function harness(nas = mockNas({})) {
  const dwar = mockDwar({});
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
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
    chaavi: mockChaavi(),
    nas,
    runtime,
  });
  return { dwar, runtime, app };
}

test("prepareUploads keeps text as text, describes images and keeps their bytes, and keeps other files as bytes", async () => {
  const dwar = mockDwar({});
  const prepared = await prepareUploads(dwar, [
    { media_type: "text/markdown", data: b64("# Report\n"), filename: "report.md" },
    { media_type: "image/png", data: PNG, filename: "dot.png" },
    { media_type: "application/pdf", data: b64("%PDF-1.4"), filename: "notes.pdf" },
  ]);

  assert.equal(dwar.describeCalls.length, 1);
  assert.equal(prepared[0]?.textContent, "# Report\n");
  assert.equal(prepared[0]?.data, null);
  assert.equal(prepared[1]?.description, "mock image description");
  assert.deepEqual(prepared[1]?.data, Buffer.from(PNG, "base64"));
  assert.equal(prepared[2]?.textContent, null);
  assert.equal(prepared[2]?.description, null);
  assert.equal(prepared[2]?.sizeBytes, 8);
});

test("prepareUploads rejects a text file that is not UTF-8", async () => {
  await assert.rejects(
    prepareUploads(mockDwar({}), [
      { media_type: "text/plain", data: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64") },
    ]),
    (err: unknown) => err instanceof HathError && err.statusCode === 422,
  );
});

test("attachmentStub shows short text whole, previews long text, and describes or labels binaries", () => {
  const short = attachmentStub(meta({ textLength: 5, textHead: "hello" }));
  assert.match(short, /\nhello$/);

  const long = "x".repeat(INLINE_TEXT_CHARS + 10);
  const preview = attachmentStub(meta({ textLength: long.length, textHead: long.slice(0, INLINE_TEXT_CHARS) }));
  assert.ok(preview.length < 1000);
  assert.match(preview, /read_attachment/);

  assert.match(attachmentStub(meta({ mediaType: "image/png", description: "a dot" })), /\na dot$/);
  assert.match(attachmentStub(meta({ mediaType: "application/pdf" })), /Not text/);
});

test("POST /messages stores attachments, the transcript shows stubs, and GET /attachments/:id returns the file", async (t) => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertWorker(handle.db, { name: "reader", systemPrompt: "reads", tools: [] });
  const { app, runtime } = await harness();
  t.after(async () => {
    await runtime.waitUntilIdle();
    await app.close();
  });
  const report = "r".repeat(INLINE_TEXT_CHARS * 2);

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
    window: wideWindow,
    db: handle.db,
    agentId,
    lane: "conversation",
    transcript: runtime.transcript,
    serviceRoot: config.serviceRoot,
  });
  const seen = JSON.stringify(context.messages);
  assert.ok(seen.includes(sent.attachments[0]!.id));
  assert.ok(!seen.includes(report));
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

test("forward_attachment copies a carried file to the recipient and read_attachment pages through it", async (t) => {
  await resetRuntime(handle.sql, handle.db, config);
  const senderId = await insertWorker(handle.db, { name: "sender", systemPrompt: "sends", tools: [] });
  const recipientId = await insertWorker(handle.db, { name: "recipient", systemPrompt: "gets", tools: [] });
  const { app, runtime } = await harness();
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

  const forwarded = await executeTool(runtime.toolContext(senderId, "conversation"), {
    type: "tool_use",
    id: "f1",
    name: FORWARD_ATTACHMENT,
    input: { to_agent_id: recipientId, attachment_ids: [originalId], note: "from Ankur" },
  });
  assert.equal(forwarded.isError, false, forwarded.content);
  const copyId = (JSON.parse(forwarded.content) as { attachments: Array<{ id: string }> }).attachments[0]!.id;
  assert.notEqual(copyId, originalId);
  const rows = await handle.db.select().from(attachments).where(eq(attachments.textContent, report));
  assert.equal(rows.length, 2);

  const received = runtime.transcript.transcriptFor(recipientId).at(-1);
  assert.equal(received?.content, "from Ankur");
  assert.equal(received?.attachments[0]?.id, copyId);

  const page = await executeTool(runtime.toolContext(recipientId, "reasoning"), {
    type: "tool_use",
    id: "r1",
    name: READ_ATTACHMENT,
    input: { attachment_id: copyId, offset: 29_990, limit: 100 },
  });
  assert.equal(page.isError, false, page.content);
  assert.deepEqual(JSON.parse(page.content), {
    attachment_id: copyId,
    filename: "report.txt",
    media_type: "text/plain",
    offset: 29_990,
    total_chars: 30_000,
    next_offset: null,
    content: "abcdefghij",
  });
});

test("create_attachment needs terminal_read_file, stores the host file, and the first send binds that same row", async (t) => {
  await resetRuntime(handle.sql, handle.db, config);
  const nas = mockNas({
    readFile: () => ({ content: "1\t# Title\n2\tbody\n", total_lines: 2, truncated: false }),
  });
  const plainId = await insertWorker(handle.db, { name: "plain", systemPrompt: "no grants", tools: [] });
  const workerId = await insertWorker(handle.db, {
    name: "writer",
    systemPrompt: "writes",
    tools: ["terminal_read_file"],
  });
  const { app, runtime } = await harness(nas);
  t.after(async () => {
    await runtime.waitUntilIdle();
    await app.close();
  });

  const denied = await executeTool(runtime.toolContext(plainId, "reasoning"), {
    type: "tool_use",
    id: "c0",
    name: CREATE_ATTACHMENT,
    input: { path: "/var/home/dadi/report.md" },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content, /^forbidden/);

  const created = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "c1",
    name: CREATE_ATTACHMENT,
    input: { path: "/var/home/dadi/report.md" },
  });
  assert.equal(created.isError, false, created.content);
  const staged = JSON.parse(created.content) as { id: string; filename: string; media_type: string };
  assert.equal(staged.filename, "report.md");
  assert.equal(staged.media_type, "text/markdown");
  const [row] = await handle.db.select().from(attachments).where(eq(attachments.id, staged.id));
  assert.equal(row?.textContent, "# Title\nbody\n");
  assert.equal(row?.messageId, null);

  const unknown = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "s0",
    name: SEND_MESSAGE,
    input: { to_agent_id: null, intent: "send it", attachment_ids: ["00000000-0000-4000-8000-000000000000"] },
  });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /^not_found/);

  const sent = await executeTool(runtime.toolContext(workerId, "conversation"), {
    type: "tool_use",
    id: "f1",
    name: FORWARD_ATTACHMENT,
    input: { to_agent_id: null, attachment_ids: [staged.id], note: "your report" },
  });
  assert.equal(sent.isError, false, sent.content);
  assert.equal(
    (JSON.parse(sent.content) as { attachments: Array<{ id: string }> }).attachments[0]?.id,
    staged.id,
  );
  const [bound] = await handle.db.select().from(attachments).where(eq(attachments.id, staged.id));
  assert.notEqual(bound?.messageId, null);
});
