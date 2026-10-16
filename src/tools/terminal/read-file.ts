import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    path: z.string().min(1),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
    max_bytes: z.number().int().positive().optional(),
  })
  .strict();

/** Lines a read returns when the caller gives no limit. */
const DEFAULT_LIMIT_LINES = 300;

/**
 * Bytes a read returns when the caller gives no max_bytes: a page of a file, not the
 * file, since every byte stays in the wake's prompt until it is cleared (file reads were
 * 11% of all tool output on 2026-10-14 to 2026-10-16, up to 40k characters each).
 */
const DEFAULT_MAX_BYTES = 24_000;

/**
 * shapeRead returns the numbered lines, followed, when the file goes on, by where the
 * page stopped and the offset that continues it.
 */
export function shapeRead(
  response: { content: string; total_lines: number; truncated: boolean },
  offset: number,
): string {
  const content = response.content.replace(/\n$/, "");
  if (response.truncated && content.length === 0) {
    return `(line ${offset} alone is longer than max_bytes; pass a larger max_bytes to read it)`;
  }
  if (!response.truncated) {
    return content.length > 0 ? content : `(empty: ${response.total_lines} lines)`;
  }
  const last = /(?:^|\n)(\d+)\t[^\n]*$/.exec(content);
  const through = last ? Number(last[1]) : 0;
  return `${content}\n(lines through ${through} of ${response.total_lines} shown; continue with offset ${through + 1})`;
}

/** Read a host file via Nas. Intended for workers. */
export const readFile = defineTool({
  name: "terminal_read_file",
  description: `Read a text file at an absolute host path as numbered lines (N\\tline), a page at a time: ${DEFAULT_LIMIT_LINES} lines or ${DEFAULT_MAX_BYTES} bytes unless you pass limit or max_bytes. When the file goes on, the result ends with the offset that continues it. Read the part you need (terminal_grep finds line numbers) rather than whole files. Binary files fail.`,
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Absolute host path" },
      offset: { type: "number", description: "1-based start line (default 1)" },
      limit: { type: "number", description: `Max lines to return (default ${DEFAULT_LIMIT_LINES})` },
      max_bytes: { type: "number", description: `Max content bytes (default ${DEFAULT_MAX_BYTES})` },
    },
  },
  async handler(ctx, parsed) {
    const body = {
      path: parsed.path,
      ...(parsed.offset !== undefined ? { offset: parsed.offset } : {}),
      limit: parsed.limit ?? DEFAULT_LIMIT_LINES,
      max_bytes: parsed.max_bytes ?? DEFAULT_MAX_BYTES,
    };
    return nasToolCall(
      () => ctx.nas.readFile(body),
      (response) => shapeRead(response as { content: string; total_lines: number; truncated: boolean }, parsed.offset ?? 1),
      { path: parsed.path },
    );
  },
});
