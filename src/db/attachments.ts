/** Durable attachment inserts, binding and copying onto messages, and metadata/text reads. */

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { HathError } from "../errors.js";
import type { AttachmentSummary } from "../types/domain.js";
import type { Db } from "./client.js";
import { attachments, type AttachmentRow } from "./schema.js";

/** A Drizzle transaction handle, as passed to `db.transaction`'s callback. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Text attachments up to this many characters (~2k tokens) are shown whole in a transcript. */
export const INLINE_TEXT_CHARS = 8000;

/** A validated file ready to insert: text files carry `textContent`, everything else `data`. */
export type NewAttachment = {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  textContent: string | null;
  data: Buffer | null;
  /** image.describe text for images. */
  description: string | null;
};

/** What a transcript keeps per attachment: metadata and at most `INLINE_TEXT_CHARS` of text, never bytes. */
export type AttachmentMeta = {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  description: string | null;
  /** Characters of text, or null for a binary attachment. */
  textLength: number | null;
  /** The first `INLINE_TEXT_CHARS` characters of text, or null for a binary attachment. */
  textHead: string | null;
};

const metaColumns = {
  id: attachments.id,
  messageId: attachments.messageId,
  filename: attachments.filename,
  mediaType: attachments.mediaType,
  sizeBytes: attachments.sizeBytes,
  description: attachments.description,
  textLength: sql<number | null>`length(${attachments.textContent})`,
  textHead: sql<string | null>`left(${attachments.textContent}, ${INLINE_TEXT_CHARS})`,
};

/** Map metadata to its HTTP/event shape. */
export function toAttachmentSummary(meta: AttachmentMeta): AttachmentSummary {
  return {
    id: meta.id,
    filename: meta.filename,
    media_type: meta.mediaType,
    size_bytes: meta.sizeBytes,
    description: meta.description,
  };
}

/** Insert attachments no message carries yet; a later message binds them by id. */
export async function stageAttachments(
  db: Db,
  createdByAgentId: string | null,
  files: NewAttachment[],
): Promise<AttachmentMeta[]> {
  if (files.length === 0) {
    return [];
  }
  const ids = files.map(() => randomUUID());
  await db.insert(attachments).values(
    files.map((file, position) => ({
      id: ids[position]!,
      messageId: null,
      createdByAgentId,
      position,
      ...file,
    })),
  );
  return orderedMeta(db, ids);
}

/**
 * Attach files to a just-inserted message, in order: `uploads` are inserted
 * bound to it, then each `forward` id is bound when no message carries it yet
 * and copied when one does. An unknown id is a 404.
 */
export async function attachToMessage(
  tx: Tx,
  messageId: string,
  createdByAgentId: string | null,
  args: { uploads: NewAttachment[]; forward: string[] },
): Promise<AttachmentMeta[]> {
  let position = 0;
  for (const file of args.uploads) {
    await tx.insert(attachments).values({
      id: randomUUID(),
      messageId,
      createdByAgentId,
      position: position++,
      ...file,
    });
  }
  const found = await requireAttachments(tx, args.forward);
  for (const id of args.forward) {
    if (found.get(id) === null) {
      await tx
        .update(attachments)
        .set({ messageId, position: position++ })
        .where(eq(attachments.id, id));
      continue;
    }
    await tx.execute(sql`
      INSERT INTO ${attachments} (
        "id", "message_id", "created_by_agent_id", "position", "filename", "media_type",
        "size_bytes", "text_content", "data", "description"
      )
      SELECT ${randomUUID()}, ${messageId}, "created_by_agent_id", ${position++}, "filename",
        "media_type", "size_bytes", "text_content", "data", "description"
      FROM ${attachments}
      WHERE "id" = ${id}
    `);
  }
  const rows = await tx
    .select(metaColumns)
    .from(attachments)
    .where(eq(attachments.messageId, messageId))
    .orderBy(asc(attachments.position));
  return rows.map(toMeta);
}

/**
 * Map each id to the message that carries it (null while unbound); throws
 * `404 not_found` naming the first id that does not exist.
 */
export async function requireAttachments(
  db: Db | Tx,
  ids: string[],
): Promise<Map<string, string | null>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: attachments.id, messageId: attachments.messageId })
    .from(attachments)
    .where(inArray(attachments.id, ids));
  const found = new Map(rows.map((row) => [row.id, row.messageId]));
  for (const id of ids) {
    if (!found.has(id)) {
      throw new HathError(404, "not_found", `attachment ${id} not found`);
    }
  }
  return found;
}

/** Metadata for every attachment on the given messages (all bound ones when omitted), keyed by message id in position order. */
export async function attachmentsByMessage(
  db: Db,
  messageIds?: string[],
): Promise<Map<string, AttachmentMeta[]>> {
  if (messageIds !== undefined && messageIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select(metaColumns)
    .from(attachments)
    .where(
      messageIds === undefined
        ? isNotNull(attachments.messageId)
        : inArray(attachments.messageId, messageIds),
    )
    .orderBy(asc(attachments.messageId), asc(attachments.position));
  const byMessage = new Map<string, AttachmentMeta[]>();
  for (const row of rows) {
    if (row.messageId === null) {
      throw new Error(`attachment ${row.id} lost its message`);
    }
    const list = byMessage.get(row.messageId) ?? [];
    list.push(toMeta(row));
    byMessage.set(row.messageId, list);
  }
  return byMessage;
}

/**
 * One page of a text attachment: `limit` characters from `offset` (0-based)
 * and the total length. A binary attachment is a 422 `invalid_request`.
 */
export async function readAttachmentText(
  db: Db,
  id: string,
  offset: number,
  limit: number,
): Promise<{ meta: AttachmentMeta; text: string }> {
  const [row] = await db
    .select({
      ...metaColumns,
      page: sql<string | null>`substr(${attachments.textContent}, ${offset + 1}, ${limit})`,
    })
    .from(attachments)
    .where(eq(attachments.id, id));
  if (!row) {
    throw new HathError(404, "not_found", `attachment ${id} not found`);
  }
  if (row.page === null) {
    throw new HathError(
      422,
      "invalid_request",
      `attachment ${id} is ${row.mediaType}, not text; only text attachments can be read`,
    );
  }
  return { meta: toMeta(row), text: row.page };
}

/** The full row, bytes and text included, for downloading an attachment. */
export async function getAttachment(db: Db, id: string): Promise<AttachmentRow> {
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
  if (!row) {
    throw new HathError(404, "not_found", `attachment ${id} not found`);
  }
  return row;
}

/** Delete the given attachments that no message carries; bound ones stay. */
export async function deleteUnboundAttachments(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await db
    .delete(attachments)
    .where(and(inArray(attachments.id, ids), isNull(attachments.messageId)));
}

/** Metadata for `ids`, in the order given. */
async function orderedMeta(db: Db, ids: string[]): Promise<AttachmentMeta[]> {
  const rows = await db.select(metaColumns).from(attachments).where(inArray(attachments.id, ids));
  const byId = new Map(rows.map((row) => [row.id, toMeta(row)]));
  return ids.map((id) => {
    const meta = byId.get(id);
    if (!meta) {
      throw new Error(`attachment ${id} missing after insert`);
    }
    return meta;
  });
}

/** Drop the message id from a metadata select row. */
function toMeta(row: { messageId: string | null } & AttachmentMeta): AttachmentMeta {
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    description: row.description,
    textLength: row.textLength,
    textHead: row.textHead,
  };
}
