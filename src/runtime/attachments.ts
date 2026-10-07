/**
 * Attachments: validating uploads into durable rows, the stub a transcript shows
 * for each, and the embedded tools that read, forward and create them. Files
 * travel by id, so no lane ever retypes their contents to pass them on.
 */

import { basename, extname } from "node:path";
import { z } from "zod";
import { agentIdOrUserSchema } from "../agent-id.js";
import {
  INLINE_TEXT_CHARS,
  readAttachmentText,
  stageAttachments,
  toAttachmentSummary,
  type AttachmentMeta,
  type NewAttachment,
} from "../db/attachments.js";
import type { DwarClient } from "../dwar/client.js";
import { HathError } from "../errors.js";
import {
  failWithoutAgentIdentity,
  fail,
  ok,
  requireActiveAgent,
  requireToolGrant,
  type ToolContext,
  type ToolExecResult,
} from "../tools/shared.js";
import type { DwarTool } from "../types/domain.js";
import { CREATE_ATTACHMENT, FORWARD_ATTACHMENT, READ_ATTACHMENT } from "../types/domain.js";
import { deliverAgentMessage } from "./deliver.js";

/** Mirrors Dwar `image.describe.allowed_media_types`. */
export const DESCRIBABLE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** Largest file one attachment holds; mirrors Dwar `image.describe.max_bytes`. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const MAX_ATTACHMENTS = 8;

/** Non-`text/*` media types stored and read as text. */
const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/x-sh",
]);

/** Media types create_attachment gives host files by extension; any other text file is text/plain. */
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

/** How much of a long text attachment its transcript stub previews. */
const PREVIEW_CHARS = 500;

/** read_attachment's page size when the caller gives no limit, and the most it returns at once. */
const READ_DEFAULT_CHARS = 20_000;
const READ_MAX_CHARS = 50_000;

/** Line ceiling for create_attachment's one nas read; MAX_ATTACHMENT_BYTES binds first. */
const HOST_READ_MAX_LINES = 1_000_000;

export type MessageAttachment = {
  media_type: string;
  /** Raw base64 (no data-URL prefix). */
  data: string;
  filename?: string | undefined;
};

/**
 * Validate uploaded files into rows: text files keep their UTF-8 text, images
 * are described by Dwar `/image/describe` and keep their bytes, anything else
 * keeps its bytes. Bad input is a 422 naming the attachment.
 */
export async function prepareUploads(
  dwar: DwarClient,
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
    const filename = att.filename?.trim() || `attachment-${index + 1}`;
    const base = { filename, mediaType, sizeBytes: raw.length };
    if (isTextMediaType(mediaType)) {
      prepared.push({ ...base, textContent: decodeUtf8(raw, index), data: null, description: null });
      continue;
    }
    if (DESCRIBABLE_IMAGE_TYPES.has(mediaType)) {
      const { description } = await dwar.describeImage(
        { image: { media_type: mediaType, data: raw.toString("base64") } },
        "hath/attachments",
      );
      prepared.push({ ...base, textContent: null, data: raw, description: description.trim() });
      continue;
    }
    prepared.push({ ...base, textContent: null, data: raw, description: null });
  }
  return prepared;
}

/**
 * The block a transcript shows for one attachment: a header with its id, then
 * the whole text when it is short, a preview when it is long, the description
 * for an image, and nothing more for other binaries.
 */
export function attachmentStub(meta: AttachmentMeta): string {
  const header = `[Attachment ${meta.id} · ${meta.filename} · ${meta.mediaType}`;
  if (meta.textLength === null || meta.textHead === null) {
    const size = `${formatBytes(meta.sizeBytes)}]`;
    if (meta.description !== null) {
      return `${header} · ${size}\n${meta.description}`;
    }
    return `${header} · ${size}\nNot text: forward it with forward_attachment; it cannot be read here.`;
  }
  const length = `${meta.textLength.toLocaleString("en-US")} chars, ${formatTokens(meta.textLength)}]`;
  if (meta.textLength <= INLINE_TEXT_CHARS) {
    return `${header} · ${length}\n${meta.textHead}`;
  }
  return `${header} · ${length}\n${meta.textHead.slice(0, PREVIEW_CHARS)}…\n[Preview only. Read it with read_attachment; pass it on with forward_attachment, never by retyping it.]`;
}

const readAttachmentInput = z
  .object({
    attachment_id: z.string().uuid(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(READ_MAX_CHARS).optional(),
  })
  .strict();

const forwardAttachmentInput = z
  .object({
    to_agent_id: agentIdOrUserSchema,
    attachment_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(MAX_ATTACHMENTS)
      .refine((ids) => new Set(ids).size === ids.length, "attachment_ids must not repeat"),
    note: z.string().min(1),
  })
  .strict();

const createAttachmentInput = z
  .object({
    path: z.string().refine((path) => path.startsWith("/"), "path must be absolute"),
    filename: z.string().min(1).optional(),
  })
  .strict();

/** Page through a text attachment. */
export const readAttachmentTool: DwarTool = {
  name: READ_ATTACHMENT,
  description: `Read a text attachment by its id (from an [Attachment …] block). Returns up to limit characters from offset (default ${READ_DEFAULT_CHARS}, max ${READ_MAX_CHARS}), the total length, and next_offset (null at the end). Read only what you need; to pass a file on, forward it instead of reading and retyping it. Images and other binaries cannot be read: an image's description is already in its block.`,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["attachment_id"],
    properties: {
      attachment_id: { type: "string", description: "Attachment id" },
      offset: { type: "integer", minimum: 0, description: "0-based character to start at (default 0)" },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: READ_MAX_CHARS,
        description: `Characters to return (default ${READ_DEFAULT_CHARS})`,
      },
    },
  },
};

/** Send existing attachments on to someone by id. */
export const forwardAttachmentTool: DwarTool = {
  name: FORWARD_ATTACHMENT,
  description:
    "Send attachments you can see (by id) to another agent or to the user (to_agent_id null), with a note saying what they are and what to do with them. The recipient gets the same files without anyone retyping them, so always forward a file rather than pasting its contents into dispatch_message. Does not end the turn — call yield when done.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["to_agent_id", "attachment_ids", "note"],
    properties: {
      to_agent_id: {
        type: ["string", "null"],
        description: "Recipient kebab-case agent id, or null for the user",
      },
      attachment_ids: {
        type: "array",
        items: { type: "string" },
        description: `Attachment ids to send, in order (at most ${MAX_ATTACHMENTS})`,
      },
      note: { type: "string", description: "The message the files arrive with" },
    },
  },
};

/** Turn a host text file into an attachment. */
export const createAttachmentTool: DwarTool = {
  name: CREATE_ATTACHMENT,
  description: `Turn a text file on the host into an attachment and get its id, so it can be sent with send_message's attachment_ids — for example a report a worker wrote for the user. Needs the terminal_read_file grant. Text files only, up to ${MAX_ATTACHMENT_BYTES} bytes.`,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Absolute host path" },
      filename: { type: "string", description: "Name it travels under (default: the file's name)" },
    },
  },
};

/** runReadAttachment returns one page of a text attachment. */
export async function runReadAttachment(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  const input = readAttachmentInput.parse(raw);
  const offset = input.offset ?? 0;
  const { meta, text } = await readAttachmentText(
    ctx.db,
    input.attachment_id,
    offset,
    input.limit ?? READ_DEFAULT_CHARS,
  );
  if (meta.textLength === null) {
    throw new Error(`attachment ${meta.id} read as text without a length`);
  }
  const end = offset + [...text].length;
  return ok({
    attachment_id: meta.id,
    filename: meta.filename,
    media_type: meta.mediaType,
    offset,
    total_chars: meta.textLength,
    next_offset: end < meta.textLength ? end : null,
    content: text,
  });
}

/** runForwardAttachment delivers a note carrying the given attachments from the calling agent. */
export async function runForwardAttachment(
  ctx: ToolContext,
  raw: unknown,
): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = forwardAttachmentInput.parse(raw);
  if (input.to_agent_id !== null) {
    await requireActiveAgent(ctx.db, input.to_agent_id);
  }
  const row = await deliverAgentMessage(
    {
      db: ctx.db,
      transcript: ctx.transcript,
      events: ctx.events,
      enqueueConversation: ctx.enqueueConversation,
    },
    {
      fromAgentId: ctx.callerId,
      toAgentId: input.to_agent_id,
      content: input.note,
      attachmentIds: input.attachment_ids,
    },
  );
  return ok({
    to_agent_id: row.toAgentId,
    seq: row.seq,
    attachments: row.attachments.map(toAttachmentSummary),
  });
}

/**
 * runCreateAttachment reads a host text file through Nas and stores it as an
 * unbound attachment owned by the caller. Nas returns `N\tline` rows; the
 * prefixes are stripped and the file is rebuilt with a trailing newline. A Nas
 * failure throws and reaches the model as a tool error.
 */
export async function runCreateAttachment(
  ctx: ToolContext,
  raw: unknown,
): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = createAttachmentInput.parse(raw);
  await requireToolGrant(ctx.db, ctx.callerId, "terminal_read_file");
  const response = await ctx.nas.readFile({
    path: input.path,
    limit: HOST_READ_MAX_LINES,
    max_bytes: 2 * MAX_ATTACHMENT_BYTES,
  });
  if (response.truncated) {
    return fail(`${input.path} is larger than the ${MAX_ATTACHMENT_BYTES}-byte attachment limit`);
  }
  const lines = response.content.split("\n").slice(0, -1);
  const text = lines.map((line) => line.slice(line.indexOf("\t") + 1)).join("\n") + "\n";
  const sizeBytes = Buffer.byteLength(text, "utf8");
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    return fail(`${input.path} is larger than the ${MAX_ATTACHMENT_BYTES}-byte attachment limit`);
  }
  const [meta] = await stageAttachments(ctx.db, ctx.callerId, [
    {
      filename: input.filename ?? basename(input.path),
      mediaType: TEXT_EXTENSION_TYPES[extname(input.path).toLowerCase()] ?? "text/plain",
      sizeBytes,
      textContent: text,
      data: null,
      description: null,
    },
  ]);
  if (!meta) {
    throw new Error("create_attachment staged no row");
  }
  return ok(toAttachmentSummary(meta), { path: input.path });
}

/** True for media types whose bytes are stored and read as UTF-8 text. */
function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") || TEXT_MEDIA_TYPES.has(mediaType);
}

/** Decode UTF-8 strictly; a text upload that is not valid UTF-8 is a 422. */
function decodeUtf8(raw: Buffer, index: number): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new HathError(422, "invalid_request", `attachments[${index}] is not valid UTF-8 text`);
  }
}

/** Approximate tokens at four characters each, e.g. `~12.3k tokens`. */
function formatTokens(chars: number): string {
  const tokens = Math.round(chars / 4);
  return tokens < 1000 ? `~${tokens} tokens` : `~${(tokens / 1000).toFixed(1)}k tokens`;
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
    throw new HathError(
      422,
      "invalid_request",
      `attachments[${index}].data must not be empty`,
    );
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new HathError(
      422,
      "invalid_request",
      `attachments[${index}].data is not valid base64`,
    );
  }
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length === 0) {
    throw new HathError(
      422,
      "invalid_request",
      `attachments[${index}].data must not be empty`,
    );
  }
  return buf;
}
