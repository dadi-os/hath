/**
 * Attachments: files that travel with messages. Each is a file on the box (see files.ts)
 * with a row of metadata, so a message names it by path and read_file opens it, and no lane
 * ever retypes a file to pass it on: `send` and `message` take attachment ids or file paths
 * (see resolveAttachments).
 */

import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { eq, isNull } from "drizzle-orm";
import {
  requireAttachments,
  stageAttachments,
  type AttachmentMeta,
  type NewAttachment,
} from "../db/attachments.js";
import type { Db } from "../db/client.js";
import { attachments } from "../db/schema.js";
import type { DwarClient } from "../dwar/client.js";
import { HathError } from "../errors.js";
import type { ToolContext } from "../tools/shared.js";
import { attachmentPath, DESCRIBABLE_IMAGE_TYPES, writeBytes, type FileStore } from "./files.js";

/** Largest file one attachment holds; mirrors Dwar `image.describe.max_bytes`. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const MAX_ATTACHMENTS = 8;

/** Non-`text/*` media types whose bytes are text. */
const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/x-sh",
]);

/** Media types attachHostFile gives host files by extension; any other text file is text/plain. */
const TEXT_EXTENSION_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
};

/** Binary media types attachHostFile gives host files by extension; images among them get a Dwar description. */
const BINARY_EXTENSION_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export type MessageAttachment = {
  media_type: string;
  /** Raw base64 (no data-URL prefix). */
  data: string;
  filename?: string | undefined;
};

/** What writes and describes an incoming file: the box's file store and Dwar. */
export type UploadDeps = {
  files: FileStore;
  dwar: DwarClient;
};

/**
 * prepareUploads checks uploaded files and writes each to the box, returning rows ready to
 * insert: a text file must be valid UTF-8, an image is described by Dwar
 * `/image/describe`, anything else is kept as it is. Bad input is a 422 naming the
 * attachment.
 */
export async function prepareUploads(
  deps: UploadDeps,
  files: MessageAttachment[],
): Promise<NewAttachment[]> {
  if (files.length > MAX_ATTACHMENTS) {
    throw new HathError(422, "invalid_request", `attachments exceeds max of ${MAX_ATTACHMENTS}`);
  }
  const prepared: NewAttachment[] = [];
  for (const [index, att] of files.entries()) {
    const mediaType = att.media_type.trim().toLowerCase();
    if (!mediaType) {
      throw new HathError(422, "invalid_request", `attachments[${index}].media_type is required`);
    }
    const raw = decodeBase64(att.data, index);
    if (raw.length > MAX_ATTACHMENT_BYTES) {
      throw new HathError(
        422,
        "invalid_request",
        `attachments[${index}] exceeds max size of ${MAX_ATTACHMENT_BYTES} bytes`,
      );
    }
    if (isTextMediaType(mediaType) && !isUtf8(raw)) {
      throw new HathError(422, "invalid_request", `attachments[${index}] is not valid UTF-8 text`);
    }
    const description = DESCRIBABLE_IMAGE_TYPES.has(mediaType)
      ? (
          await deps.dwar.describeImage(
            { image: { media_type: mediaType, data: raw.toString("base64") } },
            "hath/attachments",
          )
        ).description.trim()
      : null;
    prepared.push(
      await storeFile(deps.files, att.filename?.trim() || `attachment-${index + 1}`, mediaType, raw, description),
    );
  }
  return prepared;
}

/** storeFile writes `bytes` to a new attachment's place on the box and returns its row. */
async function storeFile(
  files: FileStore,
  filename: string,
  mediaType: string,
  bytes: Buffer,
  description: string | null,
): Promise<NewAttachment> {
  const id = randomUUID();
  const path = attachmentPath(files.dir, id, filename);
  await writeBytes(files, path, bytes);
  return { id, filename, mediaType, sizeBytes: bytes.length, path, description };
}

/** textAttachment stores `content` as a text file named `filename` and returns its row. */
export function textAttachment(
  files: FileStore,
  filename: string,
  mediaType: string,
  content: string,
): Promise<NewAttachment> {
  return storeFile(files, filename, mediaType, Buffer.from(content, "utf8"), null);
}

/**
 * The block a transcript shows for one attachment: a header with its id, the path of its
 * file, the description for an image, and how to open or pass it on.
 */
export function attachmentStub(meta: AttachmentMeta): string {
  const lines = [
    `[Attachment ${meta.id} · ${meta.filename} · ${meta.mediaType} · ${formatBytes(meta.sizeBytes)}]`,
    `Path: ${meta.path}`,
  ];
  if (meta.description !== null) {
    lines.push(meta.description);
  }
  lines.push("[Open it with read_file; pass it on by naming its id or path in send's attachments, never by retyping it.]");
  return lines.join("\n");
}

/** What copying a host file into an attachment needs. */
export type HostFileDeps = Pick<ToolContext, "db" | "nas" | "dwar" | "files">;

/**
 * attachHostFile reads any host file whole as bytes through Nas, writes the copy to an
 * attachment's place on the box and stores an unbound row owned by `agentId`; an image gets
 * its Dwar description. Its media type comes from the extension; an unlisted extension is
 * text/plain when the bytes are UTF-8 and application/octet-stream otherwise. A Nas
 * failure throws.
 */
export async function attachHostFile(
  deps: HostFileDeps,
  agentId: string,
  path: string,
  name?: string,
): Promise<AttachmentMeta> {
  const filename = name ?? basename(path);
  const file = await deps.nas.readFileBytes({ path, max_bytes: MAX_ATTACHMENT_BYTES });
  const bytes = Buffer.from(file.data, "base64");
  const extension = extname(path).toLowerCase();
  const mediaType =
    BINARY_EXTENSION_TYPES[extension] ??
    TEXT_EXTENSION_TYPES[extension] ??
    (isUtf8(bytes) ? "text/plain" : "application/octet-stream");
  const description = DESCRIBABLE_IMAGE_TYPES.has(mediaType)
    ? (
        await deps.dwar.describeImage(
          { image: { media_type: mediaType, data: file.data } },
          "hath/attachments",
        )
      ).description.trim()
    : null;
  const stored = await storeFile(deps.files, filename, mediaType, bytes, description);
  const [meta] = await stageAttachments(deps.db, agentId, [stored]);
  if (!meta) {
    throw new Error("attachment staged no row");
  }
  return meta;
}

/** A UUID: an attachment id rather than a path. */
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * resolveAttachments turns what `send` or `message` was given into attachment ids: an
 * entry that is an id must name an attachment that exists, and an absolute path is
 * copied as the file is now (see attachHostFile), so later changes to it do not reach
 * the message. A relative path, a repeat, or more than MAX_ATTACHMENTS entries is refused.
 */
export async function resolveAttachments(
  ctx: HostFileDeps,
  agentId: string,
  entries: string[],
): Promise<string[]> {
  if (entries.length > MAX_ATTACHMENTS) {
    throw new HathError(422, "invalid_request", `attachments exceeds max of ${MAX_ATTACHMENTS}`);
  }
  if (new Set(entries).size !== entries.length) {
    throw new HathError(422, "invalid_request", "attachments must not repeat");
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (ATTACHMENT_ID.test(entry)) {
      ids.push(entry);
    } else if (entry.startsWith("/")) {
      ids.push((await attachHostFile(ctx, agentId, entry)).id);
    } else {
      throw new HathError(422, "invalid_request", `attachment ${entry} is neither an attachment id nor an absolute file path`);
    }
  }
  await requireAttachments(ctx.db, ids);
  return ids;
}

/**
 * moveLegacyAttachments moves the bytes older rows kept in the database to files on the
 * box and clears them, so the file is the attachment's only contents. It does nothing once
 * every row has a path, and the columns it empties can then be dropped.
 */
export async function moveLegacyAttachments(db: Db, files: FileStore): Promise<number> {
  const legacy = await db.select().from(attachments).where(isNull(attachments.path));
  for (const row of legacy) {
    const bytes = row.data ?? (row.textContent === null ? null : Buffer.from(row.textContent, "utf8"));
    if (bytes === null) {
      throw new Error(`attachment ${row.id} has neither a file nor stored bytes`);
    }
    const path = attachmentPath(files.dir, row.id, row.filename);
    await writeBytes(files, path, bytes);
    await db.update(attachments).set({ path, textContent: null, data: null }).where(eq(attachments.id, row.id));
  }
  return legacy.length;
}

/** True for media types whose bytes are text. */
function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") || TEXT_MEDIA_TYPES.has(mediaType);
}

/** Human-readable size, e.g. `34 KB`. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function decodeBase64(data: string, index: number): Buffer {
  const cleaned = data.replace(/\s+/g, "");
  if (!cleaned) {
    throw new HathError(422, "invalid_request", `attachments[${index}].data must not be empty`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new HathError(422, "invalid_request", `attachments[${index}].data is not valid base64`);
  }
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length === 0) {
    throw new HathError(422, "invalid_request", `attachments[${index}].data must not be empty`);
  }
  return buf;
}
