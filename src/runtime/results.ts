/**
 * read_result: a lane reopens one of its own earlier tool results from hath's log by the
 * call's tool_use_id, a page at a time or by a pattern, instead of running the tool again.
 * Receipts (wake.ts) and `[Did]` entries (record.ts) name the id. Results are stored whole
 * in agent_logs, so nothing is lost when a result leaves the prompt; a tool that shows less
 * than it read (web_fetch shows answers, not pages) stores the whole under `full`, which
 * this reads instead.
 */

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { agentLogs } from "../db/schema.js";
import type { DwarTool } from "../types/domain.js";
import { READ_RESULT } from "../types/domain.js";
import { fail, failWithoutAgentIdentity, ok, type ToolContext, type ToolExecResult } from "../tools/shared.js";

/** Characters a page returns when the caller gives no limit. */
const DEFAULT_PAGE_CHARS = 8_000;

/** Most characters one page may return. */
const MAX_PAGE_CHARS = 20_000;

/** Most matching lines a pattern search returns. */
const MAX_MATCHES = 100;

/** Longest matching line a search shows. */
const MATCH_LINE_CHARS = 300;

const readResultInput = z
  .object({
    id: z.string().min(1),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_CHARS).optional(),
    pattern: z.string().min(1).optional(),
  })
  .strict();

export const readResultTool: DwarTool = {
  name: READ_RESULT,
  description: `Reopen one of your own earlier tool results by its id (a call's tool_use_id, which a [cleared] or [too large] receipt and a [Did] entry name) without running the tool again: the page went on loading, the file may have changed, and the action may not be safe to repeat. Returns ${DEFAULT_PAGE_CHARS} characters from offset (or limit, up to ${MAX_PAGE_CHARS}) with next_offset while more remains, or with pattern (a case-insensitive regex) the matching lines with their line numbers.`,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", description: "The tool_use_id of the call whose result you want" },
      offset: { type: "integer", minimum: 0, description: "Character offset to start from (default 0)" },
      limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_CHARS, description: `Characters to return (default ${DEFAULT_PAGE_CHARS})` },
      pattern: { type: "string", description: "Case-insensitive regex: return only the matching lines, numbered" },
    },
  },
};

/** runReadResult reads the caller's own logged result for a tool_use_id. */
export async function runReadResult(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = readResultInput.parse(raw);
  const [row] = await ctx.db
    .select({ payload: agentLogs.payload })
    .from(agentLogs)
    .where(
      and(
        eq(agentLogs.agentId, ctx.callerId),
        eq(agentLogs.event, "tool_result"),
        sql`${agentLogs.payload}->>'tool_use_id' = ${input.id}`,
      ),
    )
    .limit(1);
  if (row === undefined) {
    return fail(`not_found: no result of yours has id ${input.id}`);
  }
  const stored = row.payload.full ?? row.payload.content;
  const content = typeof stored === "string" ? stored : JSON.stringify(stored);
  const tool = typeof row.payload.name === "string" ? row.payload.name : null;
  if (input.pattern !== undefined) {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, "i");
    } catch (err) {
      return fail(`invalid pattern: ${err instanceof Error ? err.message : String(err)}`);
    }
    const lines = content.split("\n");
    const matches: string[] = [];
    let total = 0;
    lines.forEach((line, index) => {
      if (!regex.test(line)) {
        return;
      }
      total += 1;
      if (matches.length < MAX_MATCHES) {
        matches.push(`${index + 1}: ${line.length > MATCH_LINE_CHARS ? `${line.slice(0, MATCH_LINE_CHARS)}…` : line}`);
      }
    });
    return ok({ id: input.id, tool, total_chars: content.length, total_lines: lines.length, matches: total, lines: matches.join("\n") });
  }
  const offset = input.offset ?? 0;
  const end = Math.min(content.length, offset + (input.limit ?? DEFAULT_PAGE_CHARS));
  return ok({
    id: input.id,
    tool,
    total_chars: content.length,
    offset,
    next_offset: end < content.length ? end : null,
    content: content.slice(offset, end),
  });
}
