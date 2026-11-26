/**
 * Files sent the old way, as base64 in a request: written to the Inbox on the box and
 * returned as links, so the message carries them as text like any other file.
 */

import { isUtf8 } from "node:buffer";
import { HathError } from "../errors.js";
import type { NasClient } from "../nas/client.js";
import { boxLink, inboxFolder } from "./box-link.js";
import { safeName } from "./files.js";

/** Largest file the deprecated base64 input holds. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Most files one request may carry. */
const MAX_UPLOADS = 8;

/** One file of the deprecated `attachments` input of `POST /messages` and `POST /router`. */
export type MessageUpload = {
  media_type: string;
  /** Raw base64 (no data-URL prefix). */
  data: string;
  filename?: string | undefined;
};

/**
 * linkUploads writes each upload to `~/Inbox/<yyyy-mm>/` through Nas, which never overwrites
 * (a clash lands as `name (2).ext`), and returns `content` with one link per file appended
 * after a blank line. Bad input is a 422 naming the file.
 */
export async function linkUploads(nas: NasClient, content: string, uploads: MessageUpload[], now: Date): Promise<string> {
  if (uploads.length > MAX_UPLOADS) {
    throw new HathError(422, "invalid_request", `attachments exceeds max of ${MAX_UPLOADS}`);
  }
  const folder = inboxFolder(now);
  const links: string[] = [];
  for (const [index, upload] of uploads.entries()) {
    const bytes = decodeBase64(upload.data, index);
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new HathError(422, "invalid_request", `attachments[${index}] exceeds max size of ${MAX_UPLOAD_BYTES} bytes`);
    }
    const mediaType = upload.media_type.trim().toLowerCase();
    if ((mediaType.startsWith("text/") || mediaType.endsWith("json")) && !isUtf8(bytes)) {
      throw new HathError(422, "invalid_request", `attachments[${index}] is not valid UTF-8 text`);
    }
    const name = safeName(upload.filename?.trim() || `attachment-${index + 1}`);
    const { path } = await nas.uploadFile({ folder, name, data: bytes });
    links.push(boxLink(path));
  }
  return [content, links.join("\n")].filter((part) => part.length > 0).join("\n\n");
}

function decodeBase64(data: string, index: number): Buffer {
  const cleaned = data.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new HathError(422, "invalid_request", `attachments[${index}].data is not valid base64`);
  }
  return Buffer.from(cleaned, "base64");
}
