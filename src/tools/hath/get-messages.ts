import { z } from "zod";
import { agentIdSchema } from "../../agent-id.js";
import { loadMessageRecords, searchMessages } from "../../db/messages.js";
import { defineTool } from "../types.js";
import { ok, fail, requireAgent } from "../shared.js";

const input = z
  .object({
    agent_id: agentIdSchema.optional(),
    with: z.union([agentIdSchema, z.literal("ankur")]).optional(),
    search: z.string().min(2).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    include_utterances: z.boolean().optional(),
  })
  .strict();

/** Longest message content returned whole; a longer one is cut to its opening, with its full length in `content_chars`. */
const MAX_CONTENT_CHARS = 3_000;
/** Total serialized size of one result; messages past it are left for the next page (`before`). */
const MAX_RESULT_CHARS = 16_000;

/**
 * Read message history: what was said, to whom, and when, newest first. Agents read
 * themselves or a direct child. The router reads any agent, must name it, and alone may
 * add Ankur's own words to it (utterances), which belong to no agent.
 */
export const getMessages = defineTool({
  name: "get_messages",
  description:
    "Read message history for yourself or a direct child, newest first: every message sent or received, with who it was from and to, its time and its status. It is how you find what was said (a plan, a list, an approval, a link) after it left your transcript. with keeps one conversation (another agent's id, or ankur); search keeps messages whose text contains that text; since and before (ISO times) bound them, and next_before pages back. A long message is cut to its opening (content_chars is its length). get_logs is for what you did, not what was said. As the router, name the agent; include_utterances adds what Ankur said to you.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "Self or a direct child (any agent for the router, which must pass one); defaults to yourself",
      },
      with: { type: "string", description: "Only the conversation with this agent id, or ankur" },
      search: { type: "string", description: "Keep messages whose content contains this text, case-insensitive" },
      since: { type: "string", description: "ISO-8601 time with offset; only messages newer than it" },
      before: { type: "string", description: "ISO-8601 time with offset; only messages older than it" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      include_utterances: { type: "boolean", description: "Router only: also return what Ankur said to the router" },
    },
    required: [],
  },
  async handler(ctx, parsed) {
    const targetId = parsed.agent_id ?? ctx.callerId;
    if (targetId === null) {
      return fail("the router has no messages of its own; pass an agent_id");
    }
    const target = await requireAgent(ctx.db, targetId);
    if (ctx.callerId !== null && target.id !== ctx.callerId && target.parentAgentId !== ctx.callerId) {
      return fail("get_messages is limited to self or direct children");
    }
    if (parsed.include_utterances === true && ctx.callerId !== null) {
      return fail("only the router reads utterances");
    }
    const limit = parsed.limit ?? 30;
    const rows = await searchMessages(ctx.db, {
      agentId: targetId,
      ...(parsed.with !== undefined ? { party: parsed.with === "ankur" ? null : parsed.with } : {}),
      ...(parsed.search !== undefined ? { text: parsed.search } : {}),
      ...(parsed.since !== undefined ? { since: new Date(parsed.since) } : {}),
      ...(parsed.before !== undefined ? { before: new Date(parsed.before) } : {}),
      ...(parsed.include_utterances === true ? { includeUtterances: true } : {}),
      limit,
    });
    const records = await loadMessageRecords(ctx.db, rows);
    const out: Array<Omit<(typeof records)[number], "attachments"> & { content_chars: number; attachments: number }> = [];
    let size = 0;
    for (const { attachments, ...record } of records) {
      const shown = {
        ...record,
        content: record.content.slice(0, MAX_CONTENT_CHARS),
        content_chars: record.content.length,
        attachments: attachments.length,
      };
      size += JSON.stringify(shown).length;
      if (size > MAX_RESULT_CHARS && out.length > 0) {
        return ok({ messages: out, next_before: out[out.length - 1]!.created_at });
      }
      out.push(shown);
    }
    const next_before = rows.length === limit ? (out[out.length - 1]?.created_at ?? null) : null;
    return ok({ messages: out, next_before });
  },
});
