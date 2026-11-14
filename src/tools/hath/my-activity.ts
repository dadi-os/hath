import { z } from "zod";
import { agentIdSchema } from "../../agent-id.js";
import { activityBudgetChars, activityRows, localTime } from "../../runtime/activity.js";
import { ACTIVITY_KINDS } from "../../types/domain.js";
import { defineTool } from "../types.js";
import { failWithoutAgentIdentity, ok, requireAgent } from "../shared.js";

const input = z
  .object({
    kind: z.enum(ACTIVITY_KINDS).optional(),
    host: z.string().min(1).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    agent_id: agentIdSchema.optional(),
  })
  .strict();

/** Read what an agent did. */
export const myActivity = defineTool({
  name: "my_activity",
  description:
    "What an agent did, newest first: site reads, stores, recall digests, sends, routines, reminders and stops, each with the time and a short account. hath writes it from tool results. Use it to answer \"when did you last…\": a read of a site is a site_read row whose subject names the host. No row means it was not done, and you say so. Yours by default; pass agent_id to read another agent's. Returns { agent_id, activity: [{ at, kind, subject, digest, job }] }, [] when nothing matches.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: [...ACTIVITY_KINDS], description: "Only this kind of activity" },
      host: { type: "string", description: "Only rows whose subject names this host, such as d2l.msu.edu" },
      since: { type: "string", description: "ISO 8601 with offset: only rows at or after it" },
      agent_id: { type: "string", description: "Whose activity; leave out for your own" },
    },
  },
  async handler(ctx, parsed) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    const agentId = parsed.agent_id ?? ctx.callerId;
    await requireAgent(ctx.db, agentId);
    const rows = await activityRows(ctx.db, {
      agentId,
      ...(parsed.since !== undefined ? { since: new Date(parsed.since) } : {}),
      ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
      ...(parsed.host !== undefined ? { host: parsed.host } : {}),
      maxChars: activityBudgetChars(ctx.promptCeilingTokens, ctx.activityCeilingShare),
    });
    return ok({
      agent_id: agentId,
      activity: rows.map((row) => ({ at: localTime(row.at), kind: row.kind, subject: row.subject, digest: row.digest, job: row.jobId })),
    });
  },
});
