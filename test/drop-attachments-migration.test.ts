import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { boxLink } from "../src/runtime/box-link.js";
import { openTestDb } from "./helpers.js";

const handle = await openTestDb();
const statements = readFileSync(new URL("../drizzle/0032_drop_attachments.sql", import.meta.url), "utf8").split("--> statement-breakpoint");

after(async () => {
  await handle.close();
});

type Row = { message: string; position: number; filename: string; path: string | null };

/**
 * migrate runs 0032 against throwaway `messages` and `attachments` tables in their own schema, in one
 * transaction as the migrator does, and returns each message's content afterwards.
 */
async function migrate(contents: Record<string, string>, rows: Row[]): Promise<Record<string, string>> {
  const schema = `drop_attachments_${randomUUID().replaceAll("-", "")}`;
  await handle.sql.unsafe(`CREATE SCHEMA ${schema}`);
  try {
    return await handle.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
      await tx.unsafe(`CREATE TABLE messages (id text PRIMARY KEY, content text NOT NULL)`);
      await tx.unsafe(
        `CREATE TABLE attachments (id text PRIMARY KEY, message_id text, position int NOT NULL, filename text NOT NULL, path text)`,
      );
      for (const [id, content] of Object.entries(contents)) {
        await tx`INSERT INTO messages (id, content) VALUES (${id}, ${content})`;
      }
      for (const [index, row] of rows.entries()) {
        await tx`INSERT INTO attachments (id, message_id, position, filename, path) VALUES (${`a${index}`}, ${row.message}, ${row.position}, ${row.filename}, ${row.path})`;
      }
      for (const statement of statements) {
        await tx.unsafe(statement);
      }
      const dropped = await tx`SELECT to_regclass('attachments') AS found`;
      assert.equal(dropped[0]!.found, null, "the attachments table is dropped");
      const after = await tx<{ id: string; content: string }[]>`SELECT id, content FROM messages`;
      return Object.fromEntries(after.map((row) => [row.id, row.content]));
    });
  } finally {
    await handle.sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  }
}

test("a message's files become links in position order, after a blank line when it has text", async () => {
  const result = await migrate({ m1: "see these", m2: "" }, [
    { message: "m1", position: 1, filename: "b.pdf", path: "/var/home/dadi/.dadi/attachments/2/b.pdf" },
    { message: "m1", position: 0, filename: "a.txt", path: "/var/home/dadi/.dadi/attachments/1/a.txt" },
    { message: "m2", position: 0, filename: "c.png", path: "/var/home/dadi/.dadi/attachments/3/c.png" },
  ]);
  assert.equal(
    result.m1,
    "see these\n\n[a.txt](box:///var/home/dadi/.dadi/attachments/1/a.txt)\n[b.pdf](box:///var/home/dadi/.dadi/attachments/2/b.pdf)",
  );
  assert.equal(result.m2, "[c.png](box:///var/home/dadi/.dadi/attachments/3/c.png)");
});

test("a file two rows share is linked once, and rows with no message or no path add nothing", async () => {
  const shared = "/var/home/dadi/.dadi/attachments/1/a.txt";
  const result = await migrate({ m1: "x", m2: "y" }, [
    { message: "m1", position: 0, filename: "a.txt", path: shared },
    { message: "m1", position: 1, filename: "a.txt", path: shared },
    { message: "m2", position: 0, filename: "lost", path: null },
    { message: "ghost", position: 0, filename: "orphan.txt", path: "/var/home/dadi/.dadi/attachments/9/orphan.txt" },
  ]);
  assert.equal(result.m1, "x\n\n[a.txt](box:///var/home/dadi/.dadi/attachments/1/a.txt)");
  assert.equal(result.m2, "y");
});

test("the SQL encoding is the one the runtime and the clients write", async () => {
  const path = "/var/home/dadi/Inbox/2026-11/Résumé (final) [v2] 100%.pdf";
  const filename = "Résumé (final) [v2] 100%.pdf";
  const result = await migrate({ m1: "" }, [{ message: "m1", position: 0, filename, path }]);
  assert.equal(result.m1, boxLink(path));
});
