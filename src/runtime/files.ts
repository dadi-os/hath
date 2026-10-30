/**
 * Where hath keeps files on the box, and how it puts them there. Every file goes through
 * Nas's filesystem API, so an agent opens one with read_file like any other path:
 * incoming attachments, tool results too large for a prompt, and the text taken from a PDF.
 */

import { createHash } from "node:crypto";
import type { NasClient } from "../nas/client.js";
import { FIND, READ_FILE, WAIT, YIELD } from "../types/domain.js";

/** The folder hath's files live in (config `files.dir`) and the Nas that writes them. */
export type FileStore = {
  nas: NasClient;
  dir: string;
};

/** Mirrors Dwar `image.describe.allowed_media_types`. */
export const DESCRIBABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** safeName is `filename` as one path component: no separators or control characters. */
export function safeName(filename: string): string {
  const cleaned = [...filename]
    .map((char) => (char === "/" || char === "\\" || char.charCodeAt(0) < 32 ? "_" : char))
    .join("")
    .trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "file" : cleaned.slice(-150);
}

/** attachmentPath is where attachment `id` named `filename` is kept. Never rewritten. */
export function attachmentPath(dir: string, id: string, filename: string): string {
  return `${dir}/attachments/${id}/${safeName(filename)}`;
}

/** resultPath is where the whole of tool call `toolUseId`'s result is kept. */
export function resultPath(dir: string, toolUseId: string): string {
  return `${dir}/results/${safeName(toolUseId)}.txt`;
}

/** The tools whose results are not saved to a file when they are large: they are cheap to run again, or end the turn. */
const UNSAVED_TOOLS = new Set<string>([READ_FILE, FIND, YIELD, WAIT]);

/** savesResult is true when a large result of tool `name` is kept in a file, for read_file to reopen. */
export function savesResult(name: string): boolean {
  return !UNSAVED_TOOLS.has(name);
}

/** pdfTextPath is where the text of a PDF with these bytes is kept. */
export function pdfTextPath(dir: string, bytes: Buffer): string {
  return `${dir}/pdf/${createHash("sha1").update(bytes).digest("hex")}.txt`;
}

/** writeBytes puts `bytes` at `path`, replacing what was there. */
export async function writeBytes(store: FileStore, path: string, bytes: Buffer): Promise<void> {
  await store.nas.writeFile({ path, data: bytes.toString("base64") });
}
