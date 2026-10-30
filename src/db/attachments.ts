/** Durable attachment rows: inserts, binding and copying onto messages, and metadata reads. The files themselves are on the box (see runtime/files.ts). */

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { HathError } from "../errors.js";
import type { AttachmentSummary } from "../types/domain.js";
import type { Db } from "./client.js";
import { attachments, type AttachmentRow } from "./schema.js";

/** A Drizzle transaction handle, as passed to `db.transaction`'s callback. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A file already written to the box (see runtime/attachments.ts prepareUploads), ready to insert. */
export type NewAttachment = {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  /** Where the file is on the box. */
  path: string;
  /** image.describe text for images. */
  description: string | null;
};

/** What a transcript keeps per attachment: metadata and where its file is, never its contents. */
export type AttachmentMeta = {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  description: string | null;
  path: string;
};

const metaColumns = {
  id: attachments.id,
  messageId: attachments.messageId,
  filename: attachments.filename,
  mediaType: attachments.mediaType,
  sizeBytes: attachments.sizeBytes,
  description: attachments.description,
  path: attachments.path,
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
  await db.insert(attachments).values(
    files.map((file, position) => ({
      messageId: null,
      createdByAgentId,
      position,
      ...file,
    })),
  );
  return orderedMeta(db, files.map((file) => file.id));
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
        "size_bytes", "path", "description"
      )
      SELECT ${randomUUID()}, ${messageId}, "created_by_agent_id", ${position++}, "filename",
        "media_type", "size_bytes", "path", "description"
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

/** The full row, for downloading an attachment. */
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
function toMeta(row: { messageId: string | null } & Omit<AttachmentMeta, "path"> & { path: string | null }): AttachmentMeta {
  if (row.path === null) {
    throw new Error(`attachment ${row.id} has no file yet: boot moves older attachments to files before anything reads them`);
  }
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    description: row.description,
    path: row.path,
  };
}
