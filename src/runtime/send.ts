/**
 * `send_message`: every agent's way to speak. It delivers a message to Ankur, to the job's
 * requester or to an agent, and stamps it with its job. A file travels as a link in its text.
 * Nothing about what is said is refused except an agent message past AGENT_MESSAGE_MAX_CHARS;
 * the other errors are an address that cannot be delivered to.
 */

import { z } from "zod";
import { AGENT_ID_PATTERN, agentIdSchema } from "../agent-id.js";
import { fail, failWithoutAgentIdentity, ok, requireActiveAgent, requireWithinAgentMessageLimit, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import type { DwarTool, MessageStatus } from "../types/domain.js";
import { MESSAGE_STATUSES, SEND_MESSAGE } from "../types/domain.js";
import { recordActivity, sendRow } from "./activity.js";
import { deliverDeps } from "./async.js";
import { deliverAgentMessage } from "./deliver.js";
import { hasRequester, jobById } from "./jobs.js";
import type { TranscriptEntry } from "./transcript.js";

const sendInput = z
  .object({
    to: z.string().min(1),
    content: z.string().min(1),
    status: z.enum(MESSAGE_STATUSES).optional(),
  })
  .strict();

/** Every agent's voice. */
export const sendTool: DwarTool = {
  name: SEND_MESSAGE,
  description:
    'Send a message to Ankur (to: "ankur"), to whoever gave you this job (to: "requester"), or to another agent (to: its kebab-case id). It is delivered when the call returns and wakes the recipient; an agent\'s reply to something you asked comes back to this job. A file travels as a link in content, [name](box:///absolute/path), never pasted contents. status records the job when the message goes to its requester: done (the whole result), blocked (a wall you tried to get past), or needs_input (the one question only they can answer). A message over 4,000 characters to an agent arrives as its opening with the whole text in a file it links. Does not end the turn: call yield when done.',
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: '"ankur", "requester" (whoever gave you this job), or a kebab-case agent id' },
      content: { type: "string", description: "The message, exactly as the recipient reads it" },
      status: { type: "string", enum: [...MESSAGE_STATUSES], description: "The job's state when this goes to its requester: done, blocked or needs_input" },
    },
    required: ["to", "content"],
    additionalProperties: false,
  },
};

/** deliverFrom delivers one message as `caller`, belonging to the caller's job `jobId` or to the job its recipient gave it. */
export async function deliverFrom(
  ctx: ToolContext,
  caller: string,
  to: string | null,
  args: { content: string; status?: MessageStatus; jobId: string | null },
): Promise<TranscriptEntry> {
  return deliverAgentMessage(deliverDeps(ctx), {
    fromAgentId: caller,
    toAgentId: to,
    content: args.content,
    jobId: args.jobId,
    ...(args.status !== undefined ? { status: args.status } : {}),
  });
}

/**
 * recipientOf is who `name` addresses: null for Ankur, an agent id, or `requester`, the
 * requester of the caller's job (null for Ankur's). A string result is why it addresses no one.
 */
async function recipientOf(ctx: ToolContext, name: string): Promise<{ to: string | null } | string> {
  if (/^ankur$/i.test(name)) {
    return { to: null };
  }
  if (/^requester$/i.test(name)) {
    if (ctx.jobId === null) {
      return "Not sent: you are in no job, so there is no requester; name Ankur or an agent.";
    }
    const job = await jobById(ctx.db, ctx.jobId);
    return hasRequester(job) ? { to: job.requesterId } : "Not sent: this job is your own, so nobody asked and there is no requester.";
  }
  if (AGENT_ID_PATTERN.test(name)) {
    return { to: agentIdSchema.parse(name) };
  }
  return 'Not sent: to must be "ankur", "requester" or a kebab-case agent id.';
}

/** runSend delivers one message from an agent. */
export async function runSend(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const caller = ctx.callerId;
  const input = sendInput.parse(raw);
  const addressed = await recipientOf(ctx, input.to.trim());
  if (typeof addressed === "string") {
    return fail(addressed);
  }
  const to = addressed.to;
  if (to === caller) {
    return fail("Not sent: you cannot send to yourself.");
  }
  if (to !== null) {
    await requireActiveAgent(ctx.db, to);
  }
  requireWithinAgentMessageLimit(to, input.content);
  const row = await deliverFrom(ctx, caller, to, {
    content: input.content,
    jobId: ctx.jobId,
    ...(input.status !== undefined ? { status: input.status } : {}),
  });
  await recordActivity(ctx.db, { agentId: caller, jobId: ctx.jobId, ...sendRow(to, input.content) });
  const job = ctx.jobId === null ? null : await jobById(ctx.db, ctx.jobId);
  return ok(
    {
      to_agent_id: row.toAgentId,
      content: row.content,
      seq: row.seq,
      ask: to !== null && job !== null && to !== job.requesterId,
    },
    { message_id: row.id },
  );
}

/**
 * replyWithText is what happens to a turn of text and no tool call, as the agent's answer: in a job
 * whose requester has no answer yet (the job is open), the text goes to the requester as a message
 * marked done; in a routine or any job nobody asked, it ends the wake silently. True when the text
 * was taken either way, false when it is only thought (no job, or the requester already has an
 * answer or a question).
 */
export async function replyWithText(ctx: ToolContext, text: string): Promise<boolean> {
  if (ctx.jobId === null) {
    return false;
  }
  const job = await jobById(ctx.db, ctx.jobId);
  if (!hasRequester(job)) {
    return true;
  }
  if (job.state !== "open") {
    return false;
  }
  const sent = await runSend(ctx, { to: "requester", content: text, status: "done" });
  return !sent.isError;
}
