import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentIdSchema } from "../../agent-id.js";
import { scheduledMessages } from "../../db/schema.js";
import { defineTool } from "../types.js";
import { ok, fail, failOversizedAgentMessage, requireActiveAgent, failWithoutAgentIdentity } from "../shared.js";

const input = z.object({
  to_agent_id: agentIdSchema,
  content: z.string().min(1),
  run_at: z.string().datetime({ offset: true }),
  interval_minutes: z.number().int().min(1).optional(),
});

/** Schedule a future (optionally recurring) agent-to-agent message. */
export const scheduleMessage = defineTool({
  name: "schedule_message",
  description: "Deliver a message from you to another agent at a future time (run_at, ISO 8601 with offset), once or repeating every interval_minutes. Whole-day intervals (1440, 10080) keep the same local time across daylight saving. It arrives exactly as a message you sent then would. For a pattern one interval cannot express (Tuesdays and Saturdays), make one schedule per day. Returns { schedule_id, to_agent_id, run_at, interval_minutes }. You cannot schedule a message to yourself.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      to_agent_id: {
        type: "string",
        description: "Recipient agent id (not yourself)",
      },
      content: {
        type: "string",
        description: "Message body delivered at run_at",
      },
      run_at: {
        type: "string",
        description: "ISO 8601 datetime with offset for the first fire",
      },
      interval_minutes: {
        type: "integer",
        minimum: 1,
        description: "Optional repeat interval in minutes; omit for one-shot",
      },
    },
    required: ["to_agent_id", "content", "run_at"],
  },
  async handler(ctx, parsed) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    if (parsed.to_agent_id === ctx.callerId) {
      return fail("an agent cannot schedule a message to itself");
    }
    const oversized = failOversizedAgentMessage(parsed.to_agent_id, parsed.content);
    if (oversized !== null) {
      return oversized;
    }
    await requireActiveAgent(ctx.db, parsed.to_agent_id);
    const runAt = new Date(parsed.run_at);
    if (!(runAt.getTime() > Date.now())) {
      return fail("run_at must be in the future");
    }
    const id = randomUUID();
    const intervalMinutes = parsed.interval_minutes ?? null;
    await ctx.db.insert(scheduledMessages).values({
      id,
      fromAgentId: ctx.callerId,
      toAgentId: parsed.to_agent_id,
      content: parsed.content,
      runAt,
      intervalMinutes,
    });
    ctx.events.emit({ type: "schedules_changed", at: new Date().toISOString() });
    return ok({
      schedule_id: id,
      to_agent_id: parsed.to_agent_id,
      run_at: runAt.toISOString(),
      interval_minutes: intervalMinutes,
    });
  },
});
