/**
 * The outbox: how the work lane gets something said. The work lane never messages anyone
 * itself; it calls `message`, which queues the content for its process lane. The process
 * lane sends it with `send`, merging messages to one recipient and keeping them consistent
 * with what was already said, and may reword one for Ankur, but never drops one: every row
 * ends in a recorded state (see db/outbox.ts), so none is lost silently.
 */

import { z } from "zod";
import { AGENT_ID_PATTERN, agentIdSchema } from "../agent-id.js";
import { queueOutbox } from "../db/outbox.js";
import { currentRequester } from "../db/messages.js";
import type { OutboxRow } from "../db/schema.js";
import { fail, failWithoutAgentIdentity, ok, requireActiveAgent, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import type { DwarTool } from "../types/domain.js";
import { MESSAGE } from "../types/domain.js";
import { MAX_ATTACHMENTS, resolveAttachments } from "./attachments.js";

const messageInput = z
  .object({
    to: z.string().min(1),
    content: z.string().min(1),
    attachments: z.array(z.string().min(1)).max(MAX_ATTACHMENTS).optional(),
    expects_reply: z.boolean().optional(),
  })
  .strict();

/** The label that opens the process lane's turn listing the work lane's waiting messages. */
export const OUTBOX_LABEL = "[Messages from work]";

/** The work lane's way to get anything said to Ankur, a requester or another agent. */
export const messageTool: DwarTool = {
  name: MESSAGE,
  description:
    'Give your process lane something to say: a result, a question, an update, or a request for another agent (to: "ankur", "requester" for whoever gave you this job, or an agent id). You never message anyone yourself; your process lane sends it, may merge it with other messages to the same recipient and keep it consistent with what was already said, and may reword it for Ankur, but it never drops one. The call returns at once and you keep working. attachments are file paths on the box (copied as they are now) or attachment ids. Set expects_reply when you need the recipient\'s answer: their reply wakes you, not your process lane. After sending a question or request, yield or wait; the reply wakes you.',
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
      expects_reply: { type: "boolean", description: "True when you need the recipient's answer to continue; their reply wakes you" },
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

/** runMessage queues the work lane's message and wakes the process lane to send it. */
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
  const attachmentIds = await resolveAttachments(ctx, caller, input.attachments ?? []);
  const row = await queueOutbox(ctx.db, {
    agentId: caller,
    to,
    content: input.content,
    attachmentIds,
    expectsReply: input.expects_reply === true,
  });
  ctx.enqueueProcess(caller, "a message from your work lane to send");
  return ok({ queued: row.id, to_agent_id: to, expects_reply: row.expectsReply });
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
  return `${OUTBOX_LABEL} Your work lane wants these said. Send them with send, merged where they go to the same recipient and consistent with what you already said; reword for Ankur if it reads better. None may be dropped.\n\n${blocks.join("\n\n")}`;
}

/** The turn a yield gets while messages from the work lane are still waiting. */
export function unresolvedOutboxTurn(waiting: OutboxRow[]): string {
  const list = waiting.map((row) => `#${row.id} (to ${row.toAgentId ?? "Ankur"})`).join(", ");
  return `[continue] Messages from your work lane are still waiting: ${list}. Send each one (a send to its recipient covers every message waiting for that recipient) before you yield.`;
}
