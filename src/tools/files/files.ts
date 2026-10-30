/**
 * Instant file tools through Nas's filesystem API: read_file, find, write_file, edit_file.
 * Attachments and tool results too large for a prompt are files on the box too (see
 * runtime/files.ts), so read_file opens them like any other.
 */

import { isUtf8 } from "node:buffer";
import { extname } from "node:path";
import { z } from "zod";
import { HathError } from "../../errors.js";
import { DESCRIBABLE_IMAGE_TYPES, pdfTextPath } from "../../runtime/files.js";
import { nasToolCall } from "../nas/call.js";
import { fail, ok, type ToolContext, type ToolExecResult } from "../shared.js";
import { defineTool } from "../types.js";
import { FIND, READ_FILE } from "../../types/domain.js";

/** Largest file read_file opens: bigger ones are searched with find, or worked on in a terminal task. */
const READ_MAX_BYTES = 10 * 1024 * 1024;

/** Characters a read returns when the caller gives no limit, and the most it returns at once. */
const DEFAULT_PAGE_CHARS = 20_000;
const MAX_PAGE_CHARS = 50_000;

/** Most matching lines a pattern read returns, and the longest line it shows whole. */
const MAX_PATTERN_MATCHES = 100;
const MATCH_LINE_CHARS = 300;

/** Most paths a name search returns, and most matching lines a text search returns. */
const FIND_MAX_PATHS = 200;
const FIND_MAX_MATCHES = 100;

/** Image media types by extension, for the files read_file describes. */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const absolutePath = z.string().refine((path) => path.startsWith("/"), "path must be absolute");

const readInput = z
  .object({
    path: absolutePath,
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_CHARS).optional(),
    pattern: z.string().min(1).optional(),
  })
  .strict();

/** Open a file on the box. */
export const readFile = defineTool({
  name: READ_FILE,
  description: `Read a file on the box by its absolute path: text, a PDF as text, or an image as a description. It opens everything that is a file here: files you find, files helpers wrote, attachments (their message shows the path) and a tool result that was too large for the prompt (its receipt shows the path). Returns ${DEFAULT_PAGE_CHARS} characters from offset (or limit, up to ${MAX_PAGE_CHARS}), the file's total length and next_offset while more remains. With pattern (a case-insensitive regular expression) it returns instead the matching lines with their line numbers. Read what you need, not the whole file. Files over 10 MB and binary files other than PDFs and images are refused; find searches inside large text files. To change a file use edit_file or write_file.`,
  input: readInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Absolute path of the file" },
      offset: { type: "integer", minimum: 0, description: "Character to start at (default 0)" },
      limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_CHARS, description: `Characters to return (default ${DEFAULT_PAGE_CHARS})` },
      pattern: { type: "string", description: "Case-insensitive regular expression: return only the matching lines, numbered" },
    },
  },
  async handler(ctx, parsed) {
    try {
      return await readSource(ctx, parsed);
    } catch (err) {
      if (err instanceof HathError) {
        return fail(`${err.type}: ${err.message}`);
      }
      throw err;
    }
  },
});

/** readSource opens the file and pages or searches what it holds. */
async function readSource(ctx: ToolContext, input: z.infer<typeof readInput>): Promise<ToolExecResult> {
  const file = await ctx.nas.readFileBytes({ path: input.path, max_bytes: READ_MAX_BYTES });
  const bytes = Buffer.from(file.data, "base64");
  const extension = extname(input.path).toLowerCase();
  const imageType = IMAGE_TYPES[extension];
  if (imageType !== undefined && DESCRIBABLE_IMAGE_TYPES.has(imageType)) {
    const { description } = await ctx.dwar.describeImage(
      { image: { media_type: imageType, data: file.data } },
      "hath/read_file",
    );
    return ok({ path: input.path, kind: "image", description: description.trim() }, { path: input.path });
  }
  let text: string;
  if (extension === ".pdf" || bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    text = await pdfText(ctx, input.path, bytes);
  } else if (isUtf8(bytes) && !bytes.includes(0)) {
    text = bytes.toString("utf8");
  } else {
    throw new HathError(415, "binary_file", `${input.path} is not text, a PDF or an image; send passes a file like that on by path`);
  }
  return page(input, text);
}

/** page returns the part of `text` the caller asked for. */
function page(input: z.infer<typeof readInput>, text: string): ToolExecResult {
  const audit = { path: input.path };
  if (input.pattern !== undefined) {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, "i");
    } catch (err) {
      return fail(`invalid pattern: ${err instanceof Error ? err.message : String(err)}`);
    }
    const lines = text.split("\n");
    const matches: string[] = [];
    let total = 0;
    lines.forEach((line, index) => {
      if (!regex.test(line)) {
        return;
      }
      total += 1;
      if (matches.length < MAX_PATTERN_MATCHES) {
        matches.push(`${index + 1}: ${line.length > MATCH_LINE_CHARS ? `${line.slice(0, MATCH_LINE_CHARS)}…` : line}`);
      }
    });
    return ok({ path: input.path, total_chars: text.length, total_lines: lines.length, matches: total, lines: matches.join("\n") }, audit);
  }
  const offset = input.offset ?? 0;
  const end = Math.min(text.length, offset + (input.limit ?? DEFAULT_PAGE_CHARS));
  return ok(
    {
      path: input.path,
      total_chars: text.length,
      offset,
      next_offset: end < text.length ? end : null,
      content: text.slice(offset, end),
    },
    audit,
  );
}

/**
 * pdfText is the text of a PDF. The box's `pdftotext` writes it once to a file beside the
 * other files hath keeps (named by the PDF's contents), run in a terminal Nas opens for the
 * purpose and closes; later reads of the same PDF read that file. A PDF with no text layer
 * (a scan) reads as empty.
 */
async function pdfText(ctx: ToolContext, path: string, bytes: Buffer): Promise<string> {
  const textPath = pdfTextPath(ctx.files.dir, bytes);
  try {
    const cached = await ctx.nas.readFileBytes({ path: textPath, max_bytes: READ_MAX_BYTES });
    return Buffer.from(cached.data, "base64").toString("utf8");
  } catch (err) {
    if (!(err instanceof HathError) || err.type !== "not_found") {
      throw err;
    }
  }
  const terminal = await ctx.nas.createTerminal("/");
  try {
    const run = await ctx.nas.exec(terminal.id, {
      command: `mkdir -p ${shellQuote(`${ctx.files.dir}/pdf`)} && pdftotext -layout ${shellQuote(path)} ${shellQuote(textPath)}`,
      timeout_seconds: 120,
    });
    if (run.exit_code !== 0) {
      throw new HathError(422, "invalid_request", `reading ${path} as a PDF failed (${run.timed_out ? "timed out" : `exit ${run.exit_code}`}): ${run.output.trim()}`);
    }
  } finally {
    await ctx.nas.closeTerminal(terminal.id);
  }
  const made = await ctx.nas.readFileBytes({ path: textPath, max_bytes: READ_MAX_BYTES });
  return Buffer.from(made.data, "base64").toString("utf8");
}

/** shellQuote is `value` as one shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const findInput = z
  .object({
    name: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    path: absolutePath.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.text !== undefined, {
    message: "give name, text or both",
  });

/** Locate files by name or by what they contain. */
export const findFiles = defineTool({
  name: FIND,
  description: `Find files on the box under path (default the dadi home): by name, by text inside them, or both. name is a glob matched against file names at any depth (*.md, report-*.pdf) or against paths under path when it contains a slash (notes/**/*.md); the result is paths, newest first, up to ${FIND_MAX_PATHS}. text is a regular expression searched in file contents (with name, only in the files that match it); the result is each matching file with its matching lines and line numbers, long lines clipped, up to ${FIND_MAX_MATCHES} lines. Use it to locate a file or a line, then read_file the part you need or edit_file it.`,
  input: findInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "Glob for file names, such as *.md or src/**/*.ts" },
      text: { type: "string", description: "Regular expression to search the files' contents for" },
      path: { type: "string", description: "Absolute directory to search under (default the dadi home)" },
    },
  },
  async handler(ctx, parsed) {
    const cwd = parsed.path !== undefined ? { cwd: parsed.path } : {};
    if (parsed.text === undefined) {
      const pattern = parsed.name!.includes("/") ? parsed.name! : `**/${parsed.name!}`;
      return nasText(
        () => ctx.nas.glob({ pattern, ...cwd, limit: FIND_MAX_PATHS }),
        (response) =>
          response.paths.length === 0
            ? "No files."
            : `${response.paths.length} files\n${response.paths.join("\n")}${response.truncated ? "\n(more exist: narrow name or path)" : ""}`,
        parsed.path !== undefined ? { path: parsed.path } : {},
      );
    }
    return nasText(
      () => ctx.nas.grep({ pattern: parsed.text!, ...(parsed.name !== undefined ? { glob: parsed.name } : {}), ...cwd, limit: FIND_MAX_MATCHES }),
      (response) => shapeMatches(response),
      parsed.path !== undefined ? { path: parsed.path } : {},
    );
  },
});

/** nasText is a Nas call whose answer reaches the model as plain text, and whose failure as a tool error. */
async function nasText<T>(fn: () => Promise<T>, shape: (data: T) => string, audit: Record<string, unknown>): Promise<ToolExecResult> {
  try {
    return { content: shape(await fn()), isError: false, audit };
  } catch (err) {
    if (err instanceof HathError) {
      return fail(`${err.type}: ${err.message}`);
    }
    throw err;
  }
}

/** shapeMatches renders matching lines grouped by file, the way ripgrep prints them. */
export function shapeMatches(response: { matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }): string {
  if (response.matches.length === 0) {
    return "No matches.";
  }
  const lines: string[] = [];
  let current: string | null = null;
  for (const match of response.matches) {
    if (match.path !== current) {
      current = match.path;
      lines.push(current);
    }
    const text = match.text.trimEnd();
    lines.push(`  ${match.line}: ${text.length > MATCH_LINE_CHARS ? `${text.slice(0, MATCH_LINE_CHARS)}… (${text.length} chars)` : text}`);
  }
  const more = response.truncated ? "\n(more matches exist: narrow text, name or path)" : "";
  return `${response.matches.length} matches\n${lines.join("\n")}${more}`;
}

const writeInput = z.object({ path: absolutePath, content: z.string() }).strict();

/** Create or replace a file. */
export const writeFile = defineTool({
  name: "write_file",
  description:
    "Create a file at an absolute path with exactly the content given, or replace it whole, making missing folders. Returns { path, bytes }. For a change to part of an existing file use edit_file, which leaves the rest untouched. It cannot write under the system folders or the Dadi state folder.",
  input: writeInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "Absolute path of the file" },
      content: { type: "string", description: "The whole file" },
    },
  },
  handler: (ctx, parsed) =>
    nasToolCall(
      () => ctx.nas.writeFile({ path: parsed.path, content: parsed.content }),
      (response) => ({ path: parsed.path, bytes: response.bytes }),
      { path: parsed.path },
    ),
});

const editInput = z.object({ path: absolutePath, old: z.string().min(1), new: z.string() }).strict();

/** Replace one exact piece of text in a file. */
export const editFile = defineTool({
  name: "edit_file",
  description:
    "Change a file by replacing the text old with new, exactly as written, whitespace included. old must occur exactly once in the file: if it is missing or occurs more than once the edit fails and the file is untouched, so include enough surrounding text to be unique. Returns { path, replaced }. Read the part you are changing first with read_file or find. To rewrite a whole file use write_file.",
  input: editInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "old", "new"],
    properties: {
      path: { type: "string", description: "Absolute path of the file" },
      old: { type: "string", description: "The exact text to replace; it must occur once" },
      new: { type: "string", description: "What to put in its place (empty deletes it)" },
    },
  },
  handler: (ctx, parsed) =>
    nasToolCall(
      () => ctx.nas.editFile({ path: parsed.path, old_string: parsed.old, new_string: parsed.new }),
      (response) => ({ path: parsed.path, replaced: response.replaced }),
      { path: parsed.path },
    ),
});
