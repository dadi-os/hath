import { z } from "zod";
import type { GrepRequest } from "../../nas/client.js";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const OUTPUT_MODES = ["files_with_matches", "content", "count"] as const;

const input = z
  .object({
    pattern: z.string().min(1),
    cwd: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
    output_mode: z.enum(OUTPUT_MODES).optional(),
    limit: z.number().int().positive().optional(),
    max_bytes: z.number().int().positive().optional(),
  })
  .strict();

/** How many matches content mode returns when the caller gives no limit. */
const CONTENT_DEFAULT_LIMIT = 100;

/**
 * How many matches the file and count modes ask Nas for, so a pattern common in a few
 * files still lists every file it is in.
 */
const FILES_SCAN_LIMIT = 5_000;

/** Longest match line content mode shows; minified files put a whole bundle on one line. */
const MATCH_LINE_CHARS = 300;

type GrepMatch = { path: string; line: number; text: string };

/**
 * shapeGrep renders Nas's matches as text, the way ripgrep prints them, instead of one
 * JSON object per match: grep was the largest tool output on 2026-10-14 to 2026-10-16
 * (19% of every character tools returned, 9.4k on average), most of it repeated keys
 * and paths. The file and count modes list each file once.
 */
export function shapeGrep(
  mode: (typeof OUTPUT_MODES)[number],
  response: { matches: GrepMatch[]; truncated: boolean },
): string {
  const { matches, truncated } = response;
  if (matches.length === 0) {
    return "No matches.";
  }
  const more = truncated ? "\n(more matches exist: narrow the pattern, cwd or glob, or raise limit)" : "";
  if (mode === "content") {
    const lines: string[] = [];
    let path: string | null = null;
    for (const match of matches) {
      if (match.path !== path) {
        path = match.path;
        lines.push(path);
      }
      const text = match.text.trimEnd();
      lines.push(`  ${match.line}: ${text.length > MATCH_LINE_CHARS ? `${text.slice(0, MATCH_LINE_CHARS)}… (${text.length} chars)` : text}`);
    }
    return `${matches.length} matches\n${lines.join("\n")}${more}`;
  }
  const counts = new Map<string, number>();
  for (const match of matches) {
    counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
  }
  const files = [...counts];
  const body =
    mode === "count"
      ? files.map(([file, count]) => `${count}\t${file}`).join("\n")
      : files.map(([file]) => file).join("\n");
  return `${matches.length} matches in ${files.length} files\n${body}${more}`;
}

/** Grep host files via Nas (ripgrep). Intended for workers. */
export const grepFiles = defineTool({
  name: "terminal_grep",
  description:
    "Search file contents on the host (absolute paths; Nas denies writes to OS/dadiOS runtime trees) with a regex (ripgrep). output_mode files_with_matches (the default) lists the files that match, count adds how many matches each has, and content shows the matching lines with their line numbers, grouped by file. Find the files first, then grep one file with content or read the lines you need with terminal_read_file. glob restricts which files are searched.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "Regex pattern" },
      cwd: {
        type: "string",
        description: "Absolute directory to search from (defaults to Nas state dir)",
      },
      glob: { type: "string", description: "Optional file glob filter for ripgrep" },
      output_mode: {
        type: "string",
        enum: [...OUTPUT_MODES],
        description: "files_with_matches (default), count, or content",
      },
      limit: { type: "number", description: `Max matches content mode shows (default ${CONTENT_DEFAULT_LIMIT})` },
      max_bytes: { type: "number", description: "Max aggregate match bytes Nas returns (default 65536)" },
    },
  },
  async handler(ctx, parsed) {
    const mode = parsed.output_mode ?? "files_with_matches";
    const body: GrepRequest = {
      pattern: parsed.pattern,
      ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
      ...(parsed.glob !== undefined ? { glob: parsed.glob } : {}),
      limit: parsed.limit ?? (mode === "content" ? CONTENT_DEFAULT_LIMIT : FILES_SCAN_LIMIT),
      ...(parsed.max_bytes !== undefined ? { max_bytes: parsed.max_bytes } : {}),
    };
    return nasToolCall(
      () => ctx.nas.grep(body),
      (response) => shapeGrep(mode, response as { matches: GrepMatch[]; truncated: boolean }),
      parsed.cwd !== undefined ? { path: parsed.cwd } : {},
    );
  },
});
