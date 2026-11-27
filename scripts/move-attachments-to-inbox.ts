/**
 * One-off, run before migration 0032 drops `attachments`: copies every file a message carried
 * into `~/Inbox/<yyyy-mm>/` (the month of the message) through Nas and points the row's `path`
 * at the copy, so 0032 links the Inbox file. Safe to rerun: rows already in the Inbox are skipped.
 */

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { loadConfig } from "../src/config.js";
import { createNasClient, type NasClient } from "../src/nas/client.js";
import { BOX_HOME, inboxFolder } from "../src/runtime/box-link.js";
import { safeName } from "../src/runtime/files.js";

/** Largest file the move reads in one piece. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

type Row = {
  id: string;
  filename: string;
  path: string | null;
  text_content: string | null;
  data: Buffer | null;
  message_created_at: Date | string;
};

/**
 * moveAttachmentsToInbox copies each bound attachment's file to the Inbox, checks the copy's
 * SHA-256 against the original bytes, and only then updates `path` on every row that named the
 * old file. A file that cannot be read, or a copy that does not match, throws and leaves the
 * rows already moved as they are. Returns how many files were copied and how many rows were
 * already in the Inbox.
 */
export async function moveAttachmentsToInbox(
  sql: postgres.Sql,
  nas: NasClient,
  log: (line: string) => void,
): Promise<{ copied: number; alreadyInInbox: number }> {
  const rows = await sql<Row[]>`
    SELECT a."id", a."filename", a."path", a."text_content", a."data", m."created_at" AS "message_created_at"
    FROM "attachments" a JOIN "messages" m ON m."id" = a."message_id"
    ORDER BY m."created_at", a."position", a."id"
  `;
  const inboxPrefix = `${BOX_HOME}/Inbox/`;
  const moved = new Map<string, string>();
  let copied = 0;
  let alreadyInInbox = 0;
  for (const row of rows) {
    if (row.path !== null && row.path.startsWith(inboxPrefix)) {
      alreadyInInbox++;
      continue;
    }
    const key = row.path ?? `row:${row.id}`;
    const known = moved.get(key);
    if (known !== undefined) {
      await sql`UPDATE "attachments" SET "path" = ${known} WHERE "id" = ${row.id}`;
      continue;
    }
    const bytes = await readBytes(nas, row);
    const { path } = await nas.uploadFile({ folder: inboxFolder(new Date(row.message_created_at)), name: safeName(row.filename), data: bytes });
    const back = Buffer.from((await nas.readFileBytes({ path, max_bytes: MAX_FILE_BYTES })).data, "base64");
    if (sha256(back) !== sha256(bytes)) {
      throw new Error(`attachment ${row.id}: ${path} does not match the original (${back.length} bytes, expected ${bytes.length})`);
    }
    await sql`UPDATE "attachments" SET "path" = ${path} WHERE "id" = ${row.id}`;
    moved.set(key, path);
    copied++;
    log(`attachment ${row.id}: ${row.path ?? "database bytes"} -> ${path} (${bytes.length} bytes)`);
  }
  return { copied, alreadyInInbox };
}

async function readBytes(nas: NasClient, row: Row): Promise<Buffer> {
  if (row.path !== null) {
    return Buffer.from((await nas.readFileBytes({ path: row.path, max_bytes: MAX_FILE_BYTES })).data, "base64");
  }
  if (row.data !== null) {
    return row.data;
  }
  if (row.text_content !== null) {
    return Buffer.from(row.text_content, "utf8");
  }
  throw new Error(`attachment ${row.id} has neither a file nor stored bytes`);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const sql = postgres(config.env.databaseUrl, { onnotice: () => {} });
  try {
    const result = await moveAttachmentsToInbox(sql, createNasClient(config), (line) => console.log(line));
    console.log(JSON.stringify(result));
  } finally {
    await sql.end();
  }
}
