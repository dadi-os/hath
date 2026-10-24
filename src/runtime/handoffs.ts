/**
 * Hand-offs: how the reasoning lane gets something said to anyone but the agents it brought
 * in. The reasoning lane does the work and calls hand_off; the conversation lane, which knows
 * how to address people and what each job is owed, sends it with dispatch_message or declines
 * it with decline_handoff. Every hand-off ends in a recorded state, so none is lost silently.
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AGENT_ID_PATTERN, agentIdSchema } from "../agent-id.js";
import { requireAttachments } from "../db/attachments.js";
import { createHandoff, getHandoff, markDeclined, pendingHandoffTo } from "../db/handoffs.js";
import { currentRequester } from "../db/messages.js";
import { agents, type HandoffRow } from "../db/schema.js";
import type { Db } from "../db/client.js";
import { fail, failWithoutAgentIdentity, ok, requireActiveAgent, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import type { DwarTool } from "../types/domain.js";
import { DECLINE_HANDOFF, HAND_OFF, HANDOFF_KINDS, HANDOFF_STATUS } from "../types/domain.js";
import { MAX_ATTACHMENTS } from "./attachments.js";
import { opensLine, reportRefusal } from "./jobs.js";

/** True when `to` is an agent `from` brought in: one it spawned, or one it opened the line to. */
export async function isControlChannel(db: Db, from: string, to: string): Promise<boolean> {
  const [child] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, to), eq(agents.parentAgentId, from)));
  return child !== undefined || (await opensLine(db, from, to));
}

const handOffInput = z
  .object({
    to: z.string().min(1),
    kind: z.enum(HANDOFF_KINDS),
    content: z.string().min(1),
    attachment_ids: z
      .array(z.string().uuid())
      .max(MAX_ATTACHMENTS)
      .refine((ids) => new Set(ids).size === ids.length, "attachment_ids must not repeat")
      .optional(),
  })
  .strict();

const declineInput = z
  .object({
    handoff_id: z.number().int().positive(),
    reason: z.string().min(1),
  })
  .strict();

/** The reasoning lane's way to get a message to Ankur, a requester, a parent or a peer. */
export const handOffTool: DwarTool = {
  name: HAND_OFF,
  description:
    "Hand your conversation lane something to say to Ankur or to any agent you did not bring in (to: \"ankur\", \"requester\" for whoever gave you this job, or an agent id). Your conversation lane sends it and sets the job status from kind, so you never address a message or write a status. kind: result (the finished work, closes the job), blocker (you cannot finish), question (only the recipient can answer), progress (your one update on the job), note (something to tell), request (something to ask of an agent). The call returns at once and you keep working; if it is not sent you hear why. Hath refuses a hand-off that breaks a job rule (a second progress update, a question still open, a result with no job behind it) and says how to fix it. One hand-off per recipient waits at a time. Agents you brought in are not handed off to: message them with send_message. After handing off a question or request, yield: the recipient's reply wakes you.",
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: '"ankur", "requester", or a kebab-case agent id (never an agent you brought in)' },
      kind: { type: "string", enum: [...HANDOFF_KINDS] },
      content: { type: "string", description: "What should be said, as the recipient should read it" },
      attachment_ids: {
        type: "array",
        items: { type: "string" },
        description: `Attachments to send with it, by id (at most ${MAX_ATTACHMENTS}); the recipient gets the files themselves`,
      },
    },
    required: ["to", "kind", "content"],
    additionalProperties: false,
  },
};

/** The conversation lane's way to return a hand-off it will not send. */
export const declineHandoffTool: DwarTool = {
  name: DECLINE_HANDOFF,
  description:
    "Decline a waiting hand-off from your reasoning lane instead of sending it. Give the reason: it is steered to reasoning as \"your hand-off was not sent\". Use it when the hand-off is wrong, stale, or covered by something already sent; send it with dispatch_message handoff_id otherwise.",
  input_schema: {
    type: "object",
    properties: {
      handoff_id: { type: "integer", description: "The number shown on the hand-off" },
      reason: { type: "string", description: "Why it is not being sent" },
    },
    required: ["handoff_id", "reason"],
    additionalProperties: false,
  },
};

/** The recipient a hand-off's `to` names; null is Ankur. */
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
 * runHandOff records the reasoning lane's hand-off and wakes the conversation lane to send
 * it. Everything the sender could get wrong is checked here, in the lane that can fix it:
 * the recipient is active and not an agent it brought in, nothing is waiting for that
 * recipient already, and the job rules that would refuse the message hold (see
 * reportRefusal), judged on the status the kind sets.
 */
export async function runHandOff(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const caller = ctx.callerId;
  const input = handOffInput.parse(raw);
  const to = await recipientOf(ctx, caller, input.to);
  if (typeof to === "object" && to !== null) {
    return to;
  }
  const who = to ?? "Ankur";
  if (to === caller) {
    return fail("Not handed off: you cannot hand off to yourself.");
  }
  if (to !== null) {
    await requireActiveAgent(ctx.db, to);
    if (await isControlChannel(ctx.db, caller, to)) {
      return fail(`Not handed off: ${to} is an agent you brought in (one you spawned, or one you messaged before it ever messaged you), so you message it yourself with send_message, not hand_off.`);
    }
  }
  const refusal = await reportRefusal(ctx.db, caller, to, HANDOFF_STATUS[input.kind]);
  if (refusal !== null) {
    return fail(refusal.replace(/^Not sent:/, "Not handed off:"));
  }
  const waiting = await pendingHandoffTo(ctx.db, caller, to);
  if (waiting !== undefined) {
    return fail(`Not handed off: hand-off #${waiting.id} to ${who} is still waiting to be sent. Wait for it to go, then hand off what it does not already say.`);
  }
  const attachmentIds = input.attachment_ids ?? [];
  await requireAttachments(ctx.db, attachmentIds);
  const row = await createHandoff(ctx.db, { agentId: caller, to, kind: input.kind, content: input.content, attachmentIds });
  ctx.enqueueConversation(caller);
  return ok({ handoff_id: row.id, to_agent_id: to, kind: row.kind, queued: true });
}

/** runDeclineHandoff returns a waiting hand-off to the reasoning lane with the reason it was not sent. */
export async function runDeclineHandoff(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const caller = ctx.callerId;
  const input = declineInput.parse(raw);
  const handoff = await getHandoff(ctx.db, input.handoff_id);
  if (handoff === undefined || handoff.agentId !== caller || handoff.state !== "pending") {
    return fail(`Hand-off #${input.handoff_id} is not waiting to be sent or declined.`);
  }
  await markDeclined(ctx.db, handoff.id, input.reason);
  ctx.steer.append(caller, `Your hand-off #${handoff.id} to ${handoff.toAgentId ?? "Ankur"} was not sent: ${input.reason}`);
  if (!ctx.locks.isBusy(caller, "reasoning")) {
    ctx.enqueueReasoning(caller);
  }
  return ok({ declined: handoff.id });
}

/** failedHandoffSteer is what the reasoning lane reads when its conversation lane failed before sending a hand-off. */
export function failedHandoffSteer(handoff: HandoffRow, reason: string): string {
  return `Your hand-off #${handoff.id} to ${handoff.toAgentId ?? "Ankur"} was not sent: your conversation lane failed (${reason}). Hand it off again if it still holds.`;
}

/** handoffsTurn is the user turn that shows the conversation lane the hand-offs waiting for it. */
export function handoffsTurn(waiting: HandoffRow[]): string {
  const blocks = waiting.map((handoff) => {
    const files = handoff.attachmentIds.length > 0 ? `\n[attachments: ${handoff.attachmentIds.join(", ")}]` : "";
    const status = HANDOFF_STATUS[handoff.kind];
    const edit = handoff.toAgentId === null ? "you may reword it" : "goes as written";
    return `#${handoff.id} · to ${handoff.toAgentId ?? "Ankur"} · ${handoff.kind}${status !== undefined ? ` (status ${status})` : ""} · ${edit}\n${handoff.content}${files}`;
  });
  return `[Hand-offs waiting] From your reasoning lane, for you to send or decline:\n\n${blocks.join("\n\n")}\n\nSend each with dispatch_message handoff_id (the recipient and status are set from the hand-off; content only to reword one to Ankur), or decline it with decline_handoff and the reason.`;
}

/** The turn a yield gets while hand-offs are still waiting. */
export function unresolvedHandoffsTurn(waiting: HandoffRow[]): string {
  const list = waiting.map((handoff) => `#${handoff.id} (to ${handoff.toAgentId ?? "Ankur"})`).join(", ");
  return `[continue] Hand-offs are still waiting: ${list}. Send each with dispatch_message handoff_id, or decline it with decline_handoff and a reason, before you yield.`;
}
