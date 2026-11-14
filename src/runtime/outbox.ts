/**
 * The outbox: how the work lane gets something said, with `queue_message`. A message to an agent
 * goes out at once under `runtime.direct_agent_messages`, and one to Ankur under
 * `runtime.direct_ankur_messages` (see runMessage). Every other is queued
 * for the process lane, which sends it with `send_message`, merging messages to one recipient and
 * keeping them consistent with what was already said, and may reword one for Ankur, but never
 * drops one: every row ends in a recorded state (see db/outbox.ts), so none is lost silently.
 */

import { z } from "zod";
import { AGENT_ID_PATTERN, agentIdSchema } from "../agent-id.js";
import { insertDeliveredOutbox, queueOutbox, settleDeliveredOutbox } from "../db/outbox.js";
import { currentRequester } from "../db/messages.js";
import type { OutboxRow } from "../db/schema.js";
import { fail, failWithoutAgentIdentity, ok, requireActiveAgent, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import type { DwarTool, MessageStatus } from "../types/domain.js";
import { MESSAGE_STATUSES, QUEUE_MESSAGE } from "../types/domain.js";
import { MAX_ATTACHMENTS, resolveAttachments } from "./attachments.js";
import { deliverFrom, oversizedNote, routineRefusal, runningRefusal, weekdayRefusal } from "./send.js";

const messageInput = z
  .object({
    to: z.string().min(1),
    content: z.string().min(1),
    attachments: z.array(z.string().min(1)).max(MAX_ATTACHMENTS).optional(),
    expects_reply: z.boolean().optional(),
    status: z.enum(MESSAGE_STATUSES).optional(),
  })
  .strict();

/** The label that opens the process lane's turn listing the work lane's waiting messages. */
export const OUTBOX_LABEL = "[Messages from work]";

/** The work lane's way to get anything said to Ankur, a requester or another agent. */
export const messageTool: DwarTool = {
  name: QUEUE_MESSAGE,
  description:
    'Say something to Ankur, to whoever gave you this job, or to another agent (to: "ankur", "requester", or an agent id): a result, a wall, a question, or a request. It goes out at once, as you wrote it, in the voice of this agent (to Ankur too, unless hath relays it through your process lane, which may merge and reword it but never drops it). Send one message per recipient with everything in it. status records the job (running, needs_input, blocked or done); with pickups on, running is refused. The call returns at once. attachments are file paths on the box (copied as they are now) or attachment ids. Set expects_reply on a message to an agent when you need its answer: the reply wakes you, not your process lane; it does nothing on a message to Ankur, whose next message always reaches your process lane. A turn of nothing but queue_message calls can end your run (a reply you expect still wakes you), so make every other call you need before it or in the same turn.',
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: '"ankur", "requester", or a kebab-case agent id' },
      content: { type: "string", description: "What should be said, as the recipient should read it" },
      attachments: {
        type: "array",
        items: { type: "string" },
        description: `Absolute file paths or attachment ids to send with it (at most ${MAX_ATTACHMENTS})`,
      },
      expects_reply: { type: "boolean", description: "True when you need an agent's answer to continue; its reply wakes you. Ignored for Ankur" },
      status: { type: "string", enum: [...MESSAGE_STATUSES], description: "Optional job status this message records" },
    },
    required: ["to", "content"],
    additionalProperties: false,
  },
};

/** The recipient `to` names; null is Ankur. */
async function recipientOf(ctx: ToolContext, caller: string, to: string): Promise<string | null | ToolExecResult> {
  const name = to.trim();
  if (/^ankur$/i.test(name)) {
    return null;
  }
  if (/^requester$/i.test(name)) {
    return currentRequester(ctx.db, caller);
  }
  if (!AGENT_ID_PATTERN.test(name)) {
    return fail('to must be "ankur", "requester", or a kebab-case agent id');
  }
  return agentIdSchema.parse(name);
}

/**
 * runMessage takes the work lane's message. One to an agent, under `runtime.direct_agent_messages`,
 * or to Ankur, under `runtime.direct_ankur_messages`, is delivered at once, recorded sent, and
 * never relayed by the process lane: a second author for a message is how one ask went out twice.
 * Any other is queued, and the process lane is woken to send it. A message with status running,
 * or giving a date without its weekday, is refused first (see send.ts). A routine wake's message is
 * held to what a routine may say first (see send.ts routineRefusal). `expects_reply` holds only
 * for an agent: Ankur's next message always reaches the process lane.
 */
export async function runMessage(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const caller = ctx.callerId;
  const input = messageInput.parse(raw);
  const to = await recipientOf(ctx, caller, input.to);
  if (typeof to === "object" && to !== null) {
    return to;
  }
  if (to === caller) {
    return fail("Not queued: you cannot message yourself.");
  }
  if (to !== null) {
    await requireActiveAgent(ctx.db, to);
  }
  const refused = runningRefusal(ctx, to, input.status) ?? weekdayRefusal(ctx, to, input.content);
  if (refused !== null) {
    return fail(refused);
  }
  const direct = to === null ? ctx.directAnkurMessages : ctx.directAgentMessages;
  const silent = await routineRefusal(ctx, caller, to, direct ? input.status : undefined, !direct);
  if (silent !== null) {
    return fail(silent);
  }
  const attachmentIds = await resolveAttachments(ctx, caller, input.attachments ?? []);
  if (direct) {
    return deliverDirect(ctx, caller, to, {
      content: input.content,
      attachmentIds,
      expectsReply: input.expects_reply === true && to !== null,
      ...(input.status !== undefined ? { status: input.status } : {}),
    });
  }
  const row = await queueOutbox(ctx.db, {
    agentId: caller,
    to,
    content: input.content,
    attachmentIds,
    expectsReply: input.expects_reply === true && to !== null,
  });
  ctx.enqueueProcess(caller, "a message from your work lane to send");
  return ok({ queued: row.id, to_agent_id: to, expects_reply: row.expectsReply });
}

/**
 * deliverDirect sends the work lane's message to `to` (null is Ankur) now, as `caller`, and
 * records it as a sent outbox row; a delivery that throws marks the row failed and rethrows.
 */
async function deliverDirect(
  ctx: ToolContext,
  caller: string,
  to: string | null,
  args: { content: string; attachmentIds: string[]; expectsReply: boolean; status?: MessageStatus },
): Promise<ToolExecResult> {
  const record = await insertDeliveredOutbox(ctx.db, {
    agentId: caller,
    to,
    content: args.content,
    attachmentIds: args.attachmentIds,
    expectsReply: args.expectsReply,
  });
  let delivered: Awaited<ReturnType<typeof deliverFrom>>;
  try {
    delivered = await deliverFrom(ctx, caller, to, {
      content: args.content,
      attachmentIds: args.attachmentIds,
      sentBy: "work",
      ...(args.status !== undefined ? { status: args.status } : {}),
    });
  } catch (err) {
    await settleDeliveredOutbox(ctx.db, record.id, { failed: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  const { row, oversized } = delivered;
  await settleDeliveredOutbox(ctx.db, record.id, { messageId: row.id! });
  return ok(
    {
      sent: row.seq,
      to_agent_id: to,
      expects_reply: args.expectsReply,
      ...(oversized ? { note: oversizedNote(args.content.length) } : {}),
    },
    { message_id: row.id },
  );
}

/** failedMessageSteer is what the work lane reads when its process lane failed before sending a message. */
export function failedMessageSteer(row: OutboxRow, reason: string): string {
  return `Your message #${row.id} to ${row.toAgentId ?? "Ankur"} was not sent: your process lane failed (${reason}). Message it again if it still holds.`;
}

/** outboxTurn is the user turn that shows the process lane the messages waiting for it. */
export function outboxTurn(waiting: OutboxRow[]): string {
  const blocks = waiting.map((row) => {
    const files = row.attachmentIds.length > 0 ? `\n[attachments: ${row.attachmentIds.join(", ")}]` : "";
    const reply = row.expectsReply ? " · expects a reply" : "";
    return `#${row.id} · to ${row.toAgentId ?? "Ankur"}${reply}\n${row.content}${files}`;
  });
  return `${OUTBOX_LABEL} Your work lane wants these said. Send them with send_message, merged where they go to the same recipient and consistent with what you already said; reword for Ankur if it reads better. None may be dropped.\n\n${blocks.join("\n\n")}`;
}

/** The turn a yield gets while messages from the work lane are still waiting. */
export function unresolvedOutboxTurn(waiting: OutboxRow[]): string {
  const list = waiting.map((row) => `#${row.id} (to ${row.toAgentId ?? "Ankur"})`).join(", ");
  return `[continue] Messages from your work lane are still waiting: ${list}. Send each one (a send to its recipient covers every message waiting for that recipient) before you yield.`;
}
