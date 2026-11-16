/**
 * `send_message`: every agent's way to speak. It delivers a message to Ankur, to the job's
 * requester or to an agent, stamps it with its job, snapshots any file path it is given into the
 * attachments store at send time. Nothing about what is said is refused: the only errors are an
 * address that cannot be delivered to.
 */

import { z } from "zod";
import { AGENT_ID_PATTERN, agentIdSchema } from "../agent-id.js";
import { toAttachmentSummary } from "../db/attachments.js";
import { fail, failWithoutAgentIdentity, ok, requireActiveAgent, AGENT_MESSAGE_MAX_CHARS, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import type { DwarTool, MessageStatus } from "../types/domain.js";
import { MESSAGE_STATUSES, SEND_MESSAGE } from "../types/domain.js";
import { MAX_ATTACHMENTS, resolveAttachments, textAttachment } from "./attachments.js";
import { recordActivity, sendRow } from "./activity.js";
import { deliverDeps } from "./async.js";
import { deliverAgentMessage } from "./deliver.js";
import { hasRequester, jobById } from "./jobs.js";
import type { TranscriptEntry } from "./transcript.js";

const sendInput = z
  .object({
    to: z.string().min(1),
    content: z.string().min(1),
    attachments: z.array(z.string().min(1)).max(MAX_ATTACHMENTS).optional(),
    status: z.enum(MESSAGE_STATUSES).optional(),
  })
  .strict();

/** Every agent's voice. */
export const sendTool: DwarTool = {
  name: SEND_MESSAGE,
  description:
    'Send a message to Ankur (to: "ankur"), to whoever gave you this job (to: "requester"), or to another agent (to: its kebab-case id). It is delivered when the call returns and wakes the recipient; an agent\'s reply to something you asked comes back to this job. attachments are absolute file paths on the box (copied as they are now) or attachment ids; never paste a file into content. status records the job when the message goes to its requester: done (the whole result), blocked (a wall you tried to get past), or needs_input (the one question only they can answer). A message over 4,000 characters to an agent arrives as its opening with the whole text attached. Does not end the turn: call yield when done.',
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: '"ankur", "requester" (whoever gave you this job), or a kebab-case agent id' },
      content: { type: "string", description: "The message, exactly as the recipient reads it" },
      attachments: {
        type: "array",
        items: { type: "string" },
        description: `Absolute file paths or attachment ids (at most ${MAX_ATTACHMENTS})`,
      },
      status: { type: "string", enum: [...MESSAGE_STATUSES], description: "The job's state when this goes to its requester: done, blocked or needs_input" },
    },
    required: ["to", "content"],
    additionalProperties: false,
  },
};

/** How much of an oversized agent message its recipient sees inline, ahead of the attached whole. */
const OVERSIZED_PREVIEW_CHARS = 1500;

/** oversizedPreview is the inline part of an agent message too long to send whole: its opening and a pointer to the rest. */
function oversizedPreview(content: string): string {
  return `${content.slice(0, OVERSIZED_PREVIEW_CHARS)}…\n\n[The whole message, ${content.length} characters, is attached as message.md.]`;
}

/**
 * deliverFrom delivers one message as `caller`: an agent message past AGENT_MESSAGE_MAX_CHARS goes as its opening with the whole
 * text attached as message.md. It belongs to the caller's job `jobId`, or to the job its recipient
 * gave it. Returns the message and whether it was cut.
 */
export async function deliverFrom(
  ctx: ToolContext,
  caller: string,
  to: string | null,
  args: { content: string; attachmentIds: string[]; status?: MessageStatus; jobId: string | null },
): Promise<{ row: TranscriptEntry; oversized: boolean }> {
  const oversized = to !== null && args.content.length > AGENT_MESSAGE_MAX_CHARS;
  const whole = oversized ? await textAttachment(ctx.files, "message.md", "text/markdown", args.content) : null;
  const row = await deliverAgentMessage(
    deliverDeps(ctx),
    {
      fromAgentId: caller,
      toAgentId: to,
      content: oversized ? oversizedPreview(args.content) : args.content,
      attachmentIds: args.attachmentIds,
      uploads: whole === null ? [] : [whole],
      jobId: args.jobId,
      ...(args.status !== undefined ? { status: args.status } : {}),
    },
  );
  return { row, oversized };
}

/** oversizedNote is what a sender is told when its agent message of `chars` characters went as an opening plus message.md. */
export function oversizedNote(chars: number): string {
  return `Delivered, but at ${chars} characters it passed the ${AGENT_MESSAGE_MAX_CHARS}-character limit, so the recipient got its opening and the whole text as message.md. Keep agent messages to what was found, in a few lines.`;
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
  const attachmentIds = await resolveAttachments(ctx, caller, input.attachments ?? []);
  const { row, oversized } = await deliverFrom(ctx, caller, to, {
    content: input.content,
    attachmentIds,
    jobId: ctx.jobId,
    ...(input.status !== undefined ? { status: input.status } : {}),
  });
  await recordActivity(ctx.db, { agentId: caller, jobId: ctx.jobId, ...sendRow(to, input.content) });
  const attached = row.attachments.length > 0 ? { attachments: row.attachments.map(toAttachmentSummary) } : {};
  const job = ctx.jobId === null ? null : await jobById(ctx.db, ctx.jobId);
  return ok(
    {
      to_agent_id: row.toAgentId,
      ...(oversized ? {} : { content: row.content }),
      seq: row.seq,
      ask: to !== null && job !== null && to !== job.requesterId,
      ...attached,
      ...(oversized ? { note: oversizedNote(input.content.length) } : {}),
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
