/**
 * `send_message`: the process lane's only way to speak. It delivers a message to Ankur or to an
 * agent, snapshots any file path it is given into the attachments store at send time, and
 * closes the work lane's waiting messages (see outbox.ts) to that recipient.
 */

import { z } from "zod";
import { AGENT_ID_PATTERN, agentIdSchema } from "../agent-id.js";
import { toAttachmentSummary } from "../db/attachments.js";
import { markSent, pendingOutbox } from "../db/outbox.js";
import { fail, failWithoutAgentIdentity, ok, requireActiveAgent, AGENT_MESSAGE_MAX_CHARS, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import type { DwarTool, MessageStatus } from "../types/domain.js";
import { MESSAGE_STATUSES, SEND_MESSAGE } from "../types/domain.js";
import { MAX_ATTACHMENTS, resolveAttachments, textAttachment } from "./attachments.js";
import { deliverAgentMessage } from "./deliver.js";
import type { TranscriptEntry } from "./transcript.js";

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
  name: SEND_MESSAGE,
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

/** The refusal a message to an agent gets from a routine wake. */
const ROUTINE_SILENT =
  "Not sent: a scheduled routine is silent. Put what you found in your file; it reaches whoever asks next. Only a wall or a decision Ankur must make today goes to him, once, with status blocked or needs_input.";

/** The statuses a routine's one message to Ankur may carry. */
const ROUTINE_STATUSES: ReadonlySet<MessageStatus> = new Set(["blocked", "needs_input"]);

/**
 * runningRefusal is why a message with `status` running to `to` (null is Ankur) must not go out,
 * or null when it may. With `runtime.hath_pickups` on, hath sends Ankur the pickup for a job that
 * takes a while, and an agent that gave a job gets the result, a wall or a question.
 */
export function runningRefusal(ctx: Pick<ToolContext, "hathPickups">, to: string | null, status: MessageStatus | undefined): string | null {
  if (!ctx.hathPickups || status !== "running") {
    return null;
  }
  return to === null
    ? "Not sent: hath sends Ankur the pickup when a job takes more than a couple of minutes. Send the result, a wall or a question, never a progress line."
    : "Not sent: an agent that gave you a job gets the result, a wall or a question, never a progress line.";
}

const MONTH_DAY = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.? \d{1,2}(?:st|nd|rd|th)?\b/g;
const WEEKDAY_BEFORE = /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|urday)?\b|\b(?:today|tonight|tomorrow|yesterday)\b/i;

/** How many characters before a date its weekday may sit. */
const WEEKDAY_REACH = 12;

/**
 * weekdayRefusal is why a message with `content` to `to` (null is Ankur) must not go out under
 * `runtime.weekday_guard`, or null when it may: a month and day (such as "Nov 9") has no weekday,
 * today, tonight, tomorrow or yesterday in the WEEKDAY_REACH characters before it.
 */
export function weekdayRefusal(ctx: Pick<ToolContext, "weekdayGuard">, to: string | null, content: string): string | null {
  if (!ctx.weekdayGuard || to !== null) {
    return null;
  }
  for (const match of content.matchAll(MONTH_DAY)) {
    if (!WEEKDAY_BEFORE.test(content.slice(Math.max(0, match.index - WEEKDAY_REACH), match.index))) {
      return `Not sent: write the weekday beside every date you give him ("${match[0]}" needs its weekday, such as "Mon ${match[0]}").`;
    }
  }
  return null;
}

/**
 * routineRefusal is why `caller`'s message to `to` (null is Ankur) must not go out of a routine
 * wake, or null when it may (and always outside one, see ToolContext.routineSince). A routine
 * messages no agent, and Ankur once, with status blocked or needs_input. `status` is the
 * send's; a queued message has none yet (its send sets it), so it is undefined there and only
 * the count applies, a waiting message to Ankur counting as his one.
 */
export async function routineRefusal(
  ctx: ToolContext,
  caller: string,
  to: string | null,
  status: MessageStatus | undefined,
  queued: boolean,
): Promise<string | null> {
  const since = ctx.routineSince;
  if (since === null) {
    return null;
  }
  if (to !== null) {
    return ROUTINE_SILENT;
  }
  const told = ctx.transcript
    .transcriptFor(caller)
    .some((row) => row.seq > since && row.fromAgentId === caller && row.toAgentId === null && row.kind !== "notice");
  const waiting = queued && (await pendingOutbox(ctx.db, caller)).some((row) => row.toAgentId === null);
  if (told || waiting) {
    return "Not sent: a scheduled routine sends Ankur one message at most, and this routine already has one for him. Put the rest in your file.";
  }
  if (!queued && (status === undefined || !ROUTINE_STATUSES.has(status))) {
    return `${ROUTINE_SILENT} If this is that one message, send it again with that status.`;
  }
  return null;
}

/**
 * deliverFrom delivers one message as `caller` (from either lane, `sentBy` saying which when it
 * is not the process lane): an agent message past AGENT_MESSAGE_MAX_CHARS goes as its opening
 * with the whole text attached as message.md. Returns the message and whether it was cut.
 */
export async function deliverFrom(
  ctx: ToolContext,
  caller: string,
  to: string | null,
  args: { content: string; attachmentIds: string[]; status?: MessageStatus; sentBy?: "work" },
): Promise<{ row: TranscriptEntry; oversized: boolean }> {
  const oversized = to !== null && args.content.length > AGENT_MESSAGE_MAX_CHARS;
  const whole = oversized ? await textAttachment(ctx.files, "message.md", "text/markdown", args.content) : null;
  const row = await deliverAgentMessage(
    {
      db: ctx.db,
      transcript: ctx.transcript,
      events: ctx.events,
      enqueueProcess: ctx.enqueueProcess,
      enqueueWork: ctx.enqueueWork,
      ...(ctx.wakeActivity !== undefined ? { wakeActivity: ctx.wakeActivity } : {}),
    },
    {
      fromAgentId: caller,
      toAgentId: to,
      content: oversized ? oversizedPreview(args.content) : args.content,
      attachmentIds: args.attachmentIds,
      uploads: whole === null ? [] : [whole],
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.sentBy !== undefined ? { sentBy: args.sentBy } : {}),
    },
  );
  return { row, oversized };
}

/** oversizedNote is what a sender is told when its agent message of `chars` characters went as an opening plus message.md. */
export function oversizedNote(chars: number): string {
  return `Delivered, but at ${chars} characters it passed the ${AGENT_MESSAGE_MAX_CHARS}-character limit, so the recipient got its opening and the whole text as message.md. Keep agent messages to what was found, in a few lines.`;
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
  const refused = runningRefusal(ctx, to, input.status) ?? weekdayRefusal(ctx, to, input.content);
  if (refused !== null) {
    return fail(refused);
  }
  const silent = await routineRefusal(ctx, caller, to, input.status, false);
  if (silent !== null) {
    return fail(silent);
  }
  const waiting = (await pendingOutbox(ctx.db, caller)).filter((row) => row.toAgentId === to);
  const attachmentIds = [
    ...new Set([...(await resolveAttachments(ctx, caller, input.attachments ?? [])), ...waiting.flatMap((row) => row.attachmentIds)]),
  ];
  const { row, oversized } = await deliverFrom(ctx, caller, to, {
    content: input.content,
    attachmentIds,
    ...(input.status !== undefined ? { status: input.status } : {}),
  });
  const closed = await markSent(ctx.db, caller, to, row.id!);
  const attached = row.attachments.length > 0 ? { attachments: row.attachments.map(toAttachmentSummary) } : {};
  return ok(
    {
      to_agent_id: row.toAgentId,
      ...(oversized ? {} : { content: row.content }),
      seq: row.seq,
      ...(closed.length > 0 ? { sent_work_messages: closed.map((entry) => entry.id) } : {}),
      ...attached,
      ...(oversized ? { note: oversizedNote(input.content.length) } : {}),
    },
    { message_id: row.id },
  );
}
