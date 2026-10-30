/**
 * `send`: the process lane's only way to speak. It delivers a message to Ankur or to an
 * agent, snapshots any file path it is given into the attachments store at send time, and
 * closes the work lane's waiting messages (see outbox.ts) to that recipient.
 */

import { z } from "zod";
import { AGENT_ID_PATTERN, agentIdSchema } from "../agent-id.js";
import { toAttachmentSummary } from "../db/attachments.js";
import { markSent, pendingOutbox } from "../db/outbox.js";
import { fail, failWithoutAgentIdentity, ok, requireActiveAgent, AGENT_MESSAGE_MAX_CHARS, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import type { DwarTool } from "../types/domain.js";
import { MESSAGE_STATUSES, SEND } from "../types/domain.js";
import { MAX_ATTACHMENTS, resolveAttachments, textAttachment } from "./attachments.js";
import { deliverAgentMessage } from "./deliver.js";

const sendInput = z
  .object({
    to: z.string().min(1),
    content: z.string().min(1),
    attachments: z.array(z.string().min(1)).max(MAX_ATTACHMENTS).optional(),
    status: z.enum(MESSAGE_STATUSES).optional(),
  })
  .strict();

/** The process lane's voice. */
export const sendTool: DwarTool = {
  name: SEND,
  description:
    'Send a message to Ankur (to: "ankur") or to another agent (to: its kebab-case id). This is the only way anything you or your work lane has to say reaches anyone; it is delivered when the call returns and wakes the recipient. Messages your work lane queued for the same recipient are sent with it and marked sent, so put everything for one recipient in one message. attachments are absolute file paths on the box (copied as they are now) or attachment ids; never paste a file into content. status is optional and only records the job: running, needs_input, blocked or done. Does not end the turn: call yield when done.',
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: '"ankur" or a kebab-case agent id' },
      content: { type: "string", description: "The message, exactly as the recipient reads it" },
      attachments: {
        type: "array",
        items: { type: "string" },
        description: `Absolute file paths or attachment ids (at most ${MAX_ATTACHMENTS})`,
      },
      status: { type: "string", enum: [...MESSAGE_STATUSES], description: "Optional job status this message records" },
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

/** runSend delivers one message from the process lane. */
export async function runSend(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const caller = ctx.callerId;
  const input = sendInput.parse(raw);
  const name = input.to.trim();
  let to: string | null;
  if (/^ankur$/i.test(name)) {
    to = null;
  } else if (AGENT_ID_PATTERN.test(name)) {
    to = agentIdSchema.parse(name);
  } else {
    return fail('to must be "ankur" or a kebab-case agent id');
  }
  if (to === caller) {
    return fail("Not sent: you cannot send to yourself.");
  }
  if (to !== null) {
    await requireActiveAgent(ctx.db, to);
  }
  const waiting = (await pendingOutbox(ctx.db, caller)).filter((row) => row.toAgentId === to);
  const attachmentIds = [
    ...new Set([...(await resolveAttachments(ctx, caller, input.attachments ?? [])), ...waiting.flatMap((row) => row.attachmentIds)]),
  ];
  const oversized = to !== null && input.content.length > AGENT_MESSAGE_MAX_CHARS;
  const whole = oversized ? await textAttachment(ctx.files, "message.md", "text/markdown", input.content) : null;
  const row = await deliverAgentMessage(
    {
      db: ctx.db,
      transcript: ctx.transcript,
      events: ctx.events,
      enqueueProcess: ctx.enqueueProcess,
      enqueueWork: ctx.enqueueWork,
      wakeOf: ctx.wakeOf,
    },
    {
      fromAgentId: caller,
      toAgentId: to,
      content: oversized ? oversizedPreview(input.content) : input.content,
      attachmentIds,
      uploads: whole === null ? [] : [whole],
      ...(input.status !== undefined ? { status: input.status } : {}),
      lane: "process",
    },
  );
  const closed = await markSent(ctx.db, caller, to, row.id!);
  const attached = row.attachments.length > 0 ? { attachments: row.attachments.map(toAttachmentSummary) } : {};
  return ok({
    to_agent_id: row.toAgentId,
    ...(oversized ? {} : { content: row.content }),
    seq: row.seq,
    ...(closed.length > 0 ? { sent_work_messages: closed.map((entry) => entry.id) } : {}),
    ...attached,
    ...(oversized
      ? {
          note: `Delivered, but at ${input.content.length} characters it passed the ${AGENT_MESSAGE_MAX_CHARS}-character limit, so the recipient got its opening and the whole text as message.md. Keep agent messages to what was found, in a few lines.`,
        }
      : {}),
  });
}
