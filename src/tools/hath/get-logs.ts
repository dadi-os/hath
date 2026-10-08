import { and, desc, eq, isNull, lt, sql, type SQL } from "drizzle-orm";
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
const MAX_STRING_CHARS = 2_000;
/** Total serialized size of one result; rows past it are left for the next page. */
const MAX_RESULT_CHARS = 40_000;

/** clipStrings returns `value` with every string longer than {@link MAX_STRING_CHARS} cut, noting how much was dropped. */
function clipStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_CHARS
      ? `${value.slice(0, MAX_STRING_CHARS)}… [${value.length - MAX_STRING_CHARS} more chars]`
      : value;
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
 * and Ankur's messages stay out of reach. The user (CLI) with no agent_id reads
 * the null identity — the router's turns and every message to or from Ankur.
 */
export const getLogs = defineTool({
  name: "get_logs",
  description:
    "Read cognition audit logs for yourself or a direct child, newest first: response rows hold one model turn in order (thinking, text, tool calls), tool_result rows hold each tool's name and outcome, message rows hold every message sent or received, so this is how you find something said earlier that has left your transcript (a plan, a list, an approval). `search` keeps rows whose content contains that text (case-insensitive); `before` (an ISO time, e.g. a result's `next_before`) pages back to older rows. Long strings are clipped and a result stops at a size budget with `next_before` set when older rows remain. Defaults to yourself when agent_id is omitted. The router may read any agent and must name one: it has no logs of its own to read. Not system HTTP logs — use nas_get_logs for those.",
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
    if (ctx.callerKind === "router" && parsed.agent_id === undefined) {
      return fail("the router is ephemeral and has no logs of its own; pass an agent_id");
    }
    const targetId = parsed.agent_id ?? ctx.callerId;
    if (targetId !== null) {
      const target = await requireAgent(ctx.db, targetId);
      if (
        ctx.callerId !== null &&
        target.id !== ctx.callerId &&
        target.parentAgentId !== ctx.callerId
      ) {
        return fail("get_logs is limited to self or direct children");
      }
    }
    const party: SQL =
      targetId === null ? isNull(agentLogs.agentId) : eq(agentLogs.agentId, targetId);
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
