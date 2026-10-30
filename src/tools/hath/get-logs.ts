import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { agentIdSchema } from "../../agent-id.js";
import { agentLogs } from "../../db/schema.js";
import { toLogRecord } from "../../serialize.js";
import { defineTool } from "../types.js";
import { ok, fail, requireAgent } from "../shared.js";

const input = z
  .object({
    agent_id: agentIdSchema.optional(),
    event: z.enum(["response", "tool_result", "message"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    search: z.string().min(2).optional(),
    before: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

/** Longest string kept whole inside a returned payload; longer ones (page trees, screenshots, file bodies) are clipped. */
const MAX_STRING_CHARS = 1_200;
/**
 * Total serialized size of one result; rows past it are left for the next page. A page
 * is a search step, not a dump: get_logs averaged 11.9k characters a call on 2026-10-14
 * to 2026-10-16, and `search` and `before` find the rest.
 */
const MAX_RESULT_CHARS = 16_000;

/**
 * clipStrings returns `value` with every string longer than {@link MAX_STRING_CHARS} cut to
 * its head and tail, noting how much of the middle was dropped: a command's result is at
 * the end of its output, so a head-only cut hides exactly what a reader looks for.
 */
function clipStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_CHARS) {
      return value;
    }
    const half = MAX_STRING_CHARS / 2;
    return `${value.slice(0, half)}… [${value.length - MAX_STRING_CHARS} chars dropped from the middle] …${value.slice(-half)}`;
  }
  if (Array.isArray(value)) {
    return value.map(clipStrings);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, clipStrings(inner)]));
  }
  return value;
}

/**
 * Query durable audit logs. Agents read themselves or a direct child. The router
 * reads any agent but never the null identity: it is ephemeral, so earlier runs
 * and Ankur's messages stay out of reach.
 */
export const getLogs = defineTool({
  name: "get_logs",
  description:
    "Read the audit log for yourself or a direct child, newest first: response rows are whole model turns (thinking, text, tool calls), tool_result rows each tool's name and outcome, message rows every message sent or received. It is how you find what was said or done after it left your transcript (a plan, a list, an approval, a result). search keeps rows containing that text; before (an ISO time, such as a result's next_before) pages back. Long text is clipped and next_before is set when older rows remain. As the router, name the agent.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "Self or a direct child (any agent for the router, which must pass one); defaults to yourself",
      },
      event: {
        type: "string",
        enum: ["response", "tool_result", "message"],
      },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      search: { type: "string", description: "Keep rows whose content contains this text, case-insensitive" },
      before: { type: "string", description: "ISO-8601 time with offset; only rows older than it" },
    },
    required: [],
  },
  async handler(ctx, parsed) {
    const targetId = parsed.agent_id ?? ctx.callerId;
    if (targetId === null) {
      return fail("the router is ephemeral and has no logs of its own; pass an agent_id");
    }
    const target = await requireAgent(ctx.db, targetId);
    if (
      ctx.callerId !== null &&
      target.id !== ctx.callerId &&
      target.parentAgentId !== ctx.callerId
    ) {
      return fail("get_logs is limited to self or direct children");
    }
    const party: SQL = eq(agentLogs.agentId, targetId);
    const limit = parsed.limit ?? 50;
    const filters: SQL[] = [party];
    if (parsed.event) {
      filters.push(eq(agentLogs.event, parsed.event));
    }
    if (parsed.search) {
      filters.push(sql`${agentLogs.payload}::text ILIKE ${`%${parsed.search}%`}`);
    }
    if (parsed.before) {
      filters.push(lt(agentLogs.createdAt, new Date(parsed.before)));
    }
    const rows = await ctx.db
      .select()
      .from(agentLogs)
      .where(and(...filters))
      .orderBy(desc(agentLogs.createdAt))
      .limit(limit);
    const logs: ReturnType<typeof toLogRecord>[] = [];
    let size = 0;
    for (const row of rows) {
      const record = { ...toLogRecord(row), payload: clipStrings(row.payload) };
      size += JSON.stringify(record).length;
      if (size > MAX_RESULT_CHARS && logs.length > 0) {
        return ok({ logs, next_before: logs[logs.length - 1]!.created_at });
      }
      logs.push(record as ReturnType<typeof toLogRecord>);
    }
    const next_before = rows.length === limit ? (logs[logs.length - 1]?.created_at ?? null) : null;
    return ok({ logs, next_before });
  },
});
