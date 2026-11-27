import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { moveAttachmentsToInbox } from "../scripts/move-attachments-to-inbox.js";
import { mockNas, openTestDb } from "./helpers.js";

const handle = await openTestDb();

after(async () => {
  await handle.close();
});

const OLD = "/var/home/dadi/.dadi/attachments";

type Seed = { id: string; message: string; filename: string; path: string | null; text?: string; data?: Buffer };
type Sql = Parameters<typeof moveAttachmentsToInbox>[0];

class Rollback extends Error {}

/** withAttachments runs `body` against throwaway `messages` and `attachments` tables in their own schema, inside one rolled-back transaction. */
async function withAttachments(messages: Record<string, Date>, seeds: Seed[], body: (sql: Sql) => Promise<void>): Promise<void> {
  const schema = `move_attachments_${randomUUID().replaceAll("-", "")}`;
  await handle.sql.unsafe(`CREATE SCHEMA ${schema}`);
  try {
    await handle.sql
      .begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
        await tx.unsafe(`CREATE TABLE messages (id text PRIMARY KEY, created_at timestamptz NOT NULL)`);
        await tx.unsafe(
          `CREATE TABLE attachments (id text PRIMARY KEY, message_id text, position int NOT NULL, filename text NOT NULL, path text, text_content text, data bytea)`,
        );
        for (const [id, at] of Object.entries(messages)) {
          await tx`INSERT INTO messages (id, created_at) VALUES (${id}, ${at.toISOString()})`;
        }
        for (const [index, seed] of seeds.entries()) {
          await tx`INSERT INTO attachments (id, message_id, position, filename, path, text_content, data)
            VALUES (${seed.id}, ${seed.message}, ${index}, ${seed.filename}, ${seed.path}, ${seed.text ?? null}, ${seed.data ?? null})`;
        }
        await body(tx as unknown as Sql);
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) {
          throw err;
        }
      });
  } finally {
    await handle.sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  }
}

async function paths(sql: Sql): Promise<Record<string, string | null>> {
  const rows = await sql<{ id: string; path: string | null }[]>`SELECT id, path FROM attachments`;
  return Object.fromEntries(rows.map((row) => [row.id, row.path]));
}

test("files and stored bytes are copied to the Inbox of their message's month, never over a file, and the rows follow", async () => {
  const nas = mockNas();
  nas.files.set(`${OLD}/a1/cv.pdf`, Buffer.from("cv bytes"));
  nas.files.set("/var/home/dadi/Inbox/2026-09/cv.pdf", Buffer.from("different"));
  const log: string[] = [];
  await withAttachments(
    { m1: new Date(2026, 8, 3), m2: new Date(2026, 9, 5) },
    [
      { id: "a1", message: "m1", filename: "cv.pdf", path: `${OLD}/a1/cv.pdf` },
      { id: "a2", message: "m2", filename: "old.txt", path: null, text: "from the database" },
      { id: "a3", message: "m2", filename: "pic.png", path: null, data: Buffer.from([1, 2, 3]) },
    ],
    async (sql) => {
      assert.deepEqual(await moveAttachmentsToInbox(sql, nas, (line) => log.push(line)), { copied: 3, alreadyInInbox: 0 });
      assert.deepEqual(await paths(sql), {
        a1: "/var/home/dadi/Inbox/2026-09/cv (2).pdf",
        a2: "/var/home/dadi/Inbox/2026-10/old.txt",
        a3: "/var/home/dadi/Inbox/2026-10/pic.png",
      });
    },
  );
  assert.equal(nas.files.get("/var/home/dadi/Inbox/2026-09/cv.pdf")?.toString(), "different");
  assert.equal(nas.files.get("/var/home/dadi/Inbox/2026-09/cv (2).pdf")?.toString(), "cv bytes");
  assert.equal(nas.files.get("/var/home/dadi/Inbox/2026-10/old.txt")?.toString(), "from the database");
  assert.equal(nas.files.get(`${OLD}/a1/cv.pdf`)?.toString(), "cv bytes", "the original stays");
  assert.equal(log.length, 3);
});

test("rows sharing a file copy it once, and a rerun leaves moved rows alone", async () => {
  const nas = mockNas();
  nas.files.set(`${OLD}/a1/x.txt`, Buffer.from("x"));
  await withAttachments(
    { m1: new Date(2026, 9, 1), m2: new Date(2026, 9, 2) },
    [
      { id: "a1", message: "m1", filename: "x.txt", path: `${OLD}/a1/x.txt` },
      { id: "a2", message: "m2", filename: "x.txt", path: `${OLD}/a1/x.txt` },
    ],
    async (sql) => {
      assert.deepEqual(await moveAttachmentsToInbox(sql, nas, () => {}), { copied: 1, alreadyInInbox: 0 });
      assert.deepEqual(await paths(sql), {
        a1: "/var/home/dadi/Inbox/2026-10/x.txt",
        a2: "/var/home/dadi/Inbox/2026-10/x.txt",
      });
      assert.deepEqual(await moveAttachmentsToInbox(sql, nas, () => {}), { copied: 0, alreadyInInbox: 2 });
      assert.equal(nas.uploadFileCalls.length, 1);
    },
  );
});

test("a file that cannot be read stops the move and changes nothing", async () => {
  const nas = mockNas();
  await withAttachments(
    { m1: new Date(2026, 9, 1) },
    [{ id: "a1", message: "m1", filename: "gone.txt", path: `${OLD}/a1/gone.txt` }],
    async (sql) => {
      await assert.rejects(moveAttachmentsToInbox(sql, nas, () => {}));
      assert.deepEqual(await paths(sql), { a1: `${OLD}/a1/gone.txt` });
    },
  );
  assert.equal(nas.uploadFileCalls.length, 0);
});
