/**
 * Built-in lane tools (send/dispatch/steer/yield/list_agents) and the executeTool dispatcher.
 * Registry tools are resolved for the work lane; the process lane uses the switch below.
 */

import { and, asc, eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { agentIdOrUserSchema, agentIdSchema } from "../agent-id.js";
import type { TranscriptEntry } from "./transcript.js";
import { getHandoff, markSent } from "../db/handoffs.js";
import { agents } from "../db/schema.js";
import { HathError } from "../errors.js";
import type { DwarTool, DwarToolUseBlock, MessageStatus } from "../types/domain.js";
import {
  CREATE_ATTACHMENT,
  DECLINE_HANDOFF,
  DISPATCH_MESSAGE,
  HAND_OFF,
  HANDOFF_STATUS,
  MESSAGE_STATUSES,
  FORWARD_ATTACHMENT,
  INGEST_MEMORY,
  LIST_AGENTS,
  MANAGE_AGENT,
  MODIFY_AGENT_PROMPT,
  READ_ATTACHMENT,
  READ_RESULT,
  RECALL_MEMORY,
  SEND_MESSAGE,
  STEER_WORK,
  WAIT,
  YIELD,
} from "../types/domain.js";
import { runReadResult } from "./results.js";
import { findEmbeddedTool, findTool } from "../tools/registry.js";
import {
  fail,
  AGENT_MESSAGE_MAX_CHARS,
  ok,
  requireAgent,
  requireActiveAgent,
  requireToolGrant,
  failWithoutAgentIdentity,
  type ToolContext,
  type ToolExecResult,
} from "../tools/shared.js";
import { requireAttachments, toAttachmentSummary, type NewAttachment } from "../db/attachments.js";
import {
  MAX_ATTACHMENTS,
  runCreateAttachment,
  runForwardAttachment,
  runReadAttachment,
} from "./attachments.js";
import { deliverAgentMessage } from "./deliver.js";
import { isControlChannel, runDeclineHandoff, runHandOff } from "./handoffs.js";
import { reportRefusal, STATUS_DESCRIPTION } from "./jobs.js";
import { runIngestMemory, runRecallMemory } from "./memory.js";
import { runManageAgent, runModifyAgentPrompt } from "./modify.js";
import { runRouterTool } from "./router.js";

export type { ToolContext, ToolExecResult } from "../tools/shared.js";
export { requireAgent, requireActiveAgent, requireToolGrant } from "../tools/shared.js";

export const sendMessageInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    to_agent_id: {
      type: "string",
      description: "Kebab-case id of an agent you brought in; anyone else, Ankur included, is reached with hand_off",
    },
    content: {
      type: "string",
      description: "The message itself, exactly as the recipient reads it",
    },
    attachment_ids: {
      type: "array",
      items: { type: "string" },
      description: `Attachments the message carries, by id (at most ${MAX_ATTACHMENTS}); the recipient gets the files themselves`,
    },
  },
  required: ["to_agent_id", "content"],
};

export const dispatchMessageInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    handoff_id: {
      type: "integer",
      description:
        "Send a waiting hand-off from your work lane. Its recipient, attachments and job status are set from it. Leave content out to send it as written; content rewords a hand-off to Ankur only. Leave to_agent_id and status out.",
    },
    to_agent_id: {
      type: ["string", "null"],
      description: "For a message of your own: recipient kebab-case agent id, or null for Ankur (the user)",
    },
    content: { type: "string", description: "For a message of your own: the message to persist and deliver" },
    status: {
      type: "string",
      enum: [...MESSAGE_STATUSES],
      description: STATUS_DESCRIPTION,
    },
  },
};

export const steerWorkInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    instruction: {
      type: "string",
      description:
        "What the work lane should do next. Omit when terminate is true and you only need to halt.",
    },
    terminate: {
      type: "boolean",
      description:
        "When true, stop the work lane in its tracks: the next tool call does not run. Use for stop/kill. Can combine with instruction.",
    },
  },
  additionalProperties: false,
};

export const yieldInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/**
 * Upper bound on a wait. A wait is for something to settle; a reply is waited for by
 * yielding, since it wakes the agent. Reply waits held the wake open (282 waits against
 * 332 yields on 2026-10-14 to 2026-10-16, two thirds of them 60s or longer), and every
 * unrelated arrival that cut one short cost a full work-lane call.
 */
export const WAIT_MAX_SECONDS = 30;

const WAIT_POLL_MS = 250;

export const waitInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    seconds: {
      type: "integer",
      minimum: 1,
      maximum: WAIT_MAX_SECONDS,
      description: `How long to pause before the work lane resumes, 1–${WAIT_MAX_SECONDS}s`,
    },
    reason: {
      type: "string",
      description: "What you are waiting for, for the log",
    },
  },
  required: ["seconds"],
  additionalProperties: false,
};

export const listAgentsInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: "Exact kebab-case agent id. Returns at most one row.",
    },
    show_retired: {
      type: "boolean",
      description: "When true, include retired agents. Defaults to false.",
    },
  },
  additionalProperties: false,
};

/** Persist and deliver the work lane's message to an agent it brought in. */
export const sendMessageTool: DwarTool = {
  name: SEND_MESSAGE,
  description:
    "Send a message to an agent you brought in, a worker or helper you gave work to. It is delivered as you write it, when the call returns, and wakes its recipient. To send files, list their ids in attachment_ids (create_attachment turns a host file into one) instead of pasting their contents. Ankur, whoever gave you your job, and every other agent are reached with hand_off: your process lane sends it. Does not end the turn: to wait for a reply, yield, and the reply wakes you.",
  input_schema: sendMessageInputSchema,
};

/** Persist and deliver a message to another agent or the user. */
export const dispatchMessageTool: DwarTool = {
  name: DISPATCH_MESSAGE,
  description:
    "Write a message to another agent or to the user (to_agent_id null), or send a hand-off waiting from your work lane (handoff_id). This is the only way a message addressed to someone but the agents you brought in is persisted. Does not end the turn — call yield when done, and not while a hand-off is waiting: send it or decline it. Hath refuses a send that breaks one of these, so follow them the first time: one message per recipient per turn, text and files together (forward_attachment carries both); a message of your own to whoever gave you a job that is still open carries a status (see the [Open jobs] note; a hand-off's status is set from its kind); an agent you gave work to hears only from your work lane, which sends it everything itself, so steer the work lane to change that work; and a send to someone who wrote after you composed it waits until you have read them. See the routing block for who to address. Domain work runs on the work lane — use steer_work for that; do not claim grants are missing because the process lane cannot see them.",
  input_schema: dispatchMessageInputSchema,
};

/** Queue an instruction for the caller's work lane. */
export const steerWorkTool: DwarTool = {
  name: STEER_WORK,
  description:
    "Direct your work lane. You manage it from the process lane: pass instruction for what it should do next (domain tools run there), and/or terminate true to halt it immediately so the next tool call does not run. Starts a work-lane wake if that lane is idle. Use terminate for stop/kill.",
  input_schema: steerWorkInputSchema,
};

/** End the current lane turn. */
export const yieldTool: DwarTool = {
  name: YIELD,
  description:
    "End this lane turn. Call when you have nothing more to do right now. Sending a message or running other tools does not end the turn — only yield does.",
  input_schema: yieldInputSchema,
};

/** Pause the work lane in place for a set duration, then resume. */
export const waitTool: DwarTool = {
  name: WAIT,
  description:
    "Pause your work lane for a few seconds while something you started settles (a command finishing, a file landing), then resume where you left off. Never wait for a person or an agent: yield instead, and their reply wakes you. For a page to load or change, use browser_wait_for. A steer, a terminate, or a new message to you cuts the wait short. Max " +
    `${WAIT_MAX_SECONDS}s; for a later time, use scheduling.`,
  input_schema: waitInputSchema,
};

/** Look up agents by exact id or list the roster (id, name alias, parent, retired). */
export const listAgentsTool: DwarTool = {
  name: LIST_AGENTS,
  description:
    "List agents visible to you: id, name (alias of id), parent, directory description (null for workers and agents that set none), and whether each is retired. Retired agents are left out unless show_retired is true. Pass id for an exact kebab-case lookup (empty list on miss, including a retired id without show_retired).",
  input_schema: listAgentsInputSchema,
};

const sendInput = z.object({
  to_agent_id: agentIdSchema,
  content: z.string().min(1),
  attachment_ids: z
    .array(z.string().uuid())
    .max(MAX_ATTACHMENTS)
    .refine((ids) => new Set(ids).size === ids.length, "attachment_ids must not repeat")
    .optional(),
});

const dispatchInput = z
  .object({
    handoff_id: z.number().int().positive().optional(),
    to_agent_id: agentIdOrUserSchema.optional(),
    content: z.string().min(1).optional(),
    status: z.enum(MESSAGE_STATUSES).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.handoff_id === undefined && (value.to_agent_id === undefined || value.content === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "send a message of your own with to_agent_id and content, or a hand-off with handoff_id" });
    }
  });

const steerInput = z
  .object({
    instruction: z.string().min(1).optional(),
    terminate: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.terminate === true || value.instruction !== undefined, {
    message: "instruction or terminate is required",
  });

const yieldInput = z.object({}).strict();

const waitInput = z
  .object({
    seconds: z.number().int().min(1).max(WAIT_MAX_SECONDS),
    reason: z.string().min(1).optional(),
  })
  .strict();

const listAgentsInput = z
  .object({
    id: agentIdSchema.optional(),
    show_retired: z.boolean().optional(),
  })
  .strict();

/** Map an unexpected throw into a tool error so the lane transcript stays valid. */
export function unexpectedToolError(err: unknown): ToolExecResult {
  if (err instanceof HathError) {
    return fail(`${err.type}: ${err.message}`);
  }
  if (err instanceof Error) {
    return fail(err.message);
  }
  return fail(String(err));
}

/** Dispatch a tool_use block for the caller's lane; map Zod/4xx to tool errors.
 * A caller that just failed waits an adaptive backoff before its next call runs. */
export async function executeTool(
  ctx: ToolContext,
  call: DwarToolUseBlock,
): Promise<ToolExecResult> {
  if (ctx.callerId !== null) {
    const wait = ctx.toolDebounce.delayBeforeNext(ctx.callerId);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  let result: ToolExecResult;
  try {
    result = await dispatchTool(ctx, call);
  } catch (err) {
    result = unexpectedToolError(err);
  }
  if (ctx.callerId !== null) {
    const sessionsBefore = JSON.stringify(ctx.sessions.forAgent(ctx.callerId));
    ctx.sessions.observe(ctx.callerId, call.name, call.input, result.isError);
    if (JSON.stringify(ctx.sessions.forAgent(ctx.callerId)) !== sessionsBefore) {
      ctx.events.emit({ type: "sessions_changed", at: new Date().toISOString() });
    }
    ctx.toolDebounce.record(ctx.callerId, result.isError);
  }
  return result;
}

/** Route one tool_use to the matching handler without session bookkeeping. */
async function dispatchTool(
  ctx: ToolContext,
  call: DwarToolUseBlock,
): Promise<ToolExecResult> {
  try {
    if (call.name === YIELD) {
      yieldInput.parse(call.input ?? {});
      return ok({ yielded: true });
    }
    if (call.name === LIST_AGENTS) {
      return await runListAgents(ctx, call.input);
    }
    if (call.name === READ_ATTACHMENT) {
      return await runReadAttachment(ctx, call.input);
    }
    if (ctx.lane === "router") {
      return await runRouterTool(ctx, call);
    }
    if (ctx.lane === "work") {
      if (call.name === SEND_MESSAGE) {
        return await runSendMessage(ctx, call.input);
      }
      if (call.name === HAND_OFF) {
        return await runHandOff(ctx, call.input);
      }
      if (call.name === WAIT) {
        return await runWait(ctx, call.input);
      }
      if (call.name === READ_RESULT) {
        return await runReadResult(ctx, call.input);
      }
      if (call.name === CREATE_ATTACHMENT) {
        return await runCreateAttachment(ctx, call.input);
      }
      if (call.name === RECALL_MEMORY) {
        return await runRecallMemory(ctx, call.input);
      }
      if (call.name === INGEST_MEMORY) {
        return await runIngestMemory(ctx, call.input);
      }
      if (call.name === MANAGE_AGENT) {
        return await runManageAgent(ctx, call.input);
      }
      if (call.name === MODIFY_AGENT_PROMPT) {
        return await runModifyAgentPrompt(ctx, call.input);
      }
      const embedded = findEmbeddedTool(call.name);
      if (embedded) {
        return await embedded.handler(ctx, embedded.input.parse(call.input));
      }
      const definition = findTool(call.name);
      if (!definition) {
        return fail(`unknown work-lane tool: ${call.name}`);
      }
      if (ctx.callerId !== null) {
        await requireActiveAgent(ctx.db, ctx.callerId);
        await requireToolGrant(ctx.db, ctx.callerId, call.name);
      }
      const parsed = definition.input.parse(call.input);
      return await definition.handler(ctx, parsed);
    }
    switch (call.name) {
      case DISPATCH_MESSAGE:
        return await runDispatchMessage(ctx, call.input);
      case FORWARD_ATTACHMENT:
        return await runForwardAttachment(ctx, call.input);
      case DECLINE_HANDOFF:
        return await runDeclineHandoff(ctx, call.input);
      case STEER_WORK:
        return await runSteerWork(ctx, call.input);
      default:
        return fail(
          `${call.name} is not a process-lane tool. Yours are ${DISPATCH_MESSAGE}, ${DECLINE_HANDOFF}, ${FORWARD_ATTACHMENT}, ${READ_ATTACHMENT}, ${STEER_WORK}, ${LIST_AGENTS} and ${YIELD}. Every other tool this agent holds, ${call.name} included if it is granted, runs in the work lane: call ${STEER_WORK} with what you need done.`,
        );
    }
  } catch (err) {
    if (err instanceof ZodError) {
      return fail(err.issues.map((issue) => issue.message).join("; "));
    }
    return unexpectedToolError(err);
  }
}

/**
 * Pause the work lane in place for a short settle, polling so a steer, a terminate,
 * or a new message to the agent cuts it short. No model calls run while waiting; the
 * loop resumes on return and the next step folds in what arrived.
 */
async function runWait(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = waitInput.parse(raw);
  const agentId = ctx.callerId;
  const started = Date.now();
  const deadline = started + input.seconds * 1000;
  const inboundAtStart = ctx.transcript.lastInboundSeq(agentId);
  while (Date.now() < deadline) {
    if (
      ctx.steer.isTerminate(agentId) ||
      ctx.steer.hasItems(agentId) ||
      ctx.transcript.lastInboundSeq(agentId) > inboundAtStart
    ) {
      return ok({ waited_seconds: Math.round((Date.now() - started) / 1000), interrupted: true });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_POLL_MS, deadline - Date.now())));
  }
  return ok({ waited_seconds: Math.round((Date.now() - started) / 1000), interrupted: false });
}

/**
 * runSendMessage delivers the work lane's message, as written, to an agent it brought
 * in: its own subordinates are directed by the lane that does their work. Everyone else
 * is reached by hand_off and the process lane (see handoffs.ts).
 */
async function runSendMessage(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = sendInput.parse(raw);
  await requireActiveAgent(ctx.db, input.to_agent_id);
  if (!(await isControlChannel(ctx.db, ctx.callerId, input.to_agent_id))) {
    return fail(
      `Not sent: ${input.to_agent_id} is not an agent you brought in. send_message is for your own workers and helpers; to reach anyone else, Ankur included, call hand_off and your process lane sends it.`,
    );
  }
  const attachmentIds = input.attachment_ids ?? [];
  await requireAttachments(ctx.db, attachmentIds);
  return (
    await deliverFromAgent(ctx, ctx.callerId, {
      to: input.to_agent_id,
      content: input.content,
      attachmentIds,
      status: undefined,
    })
  ).result;
}

/** How much of an oversized agent message its recipient sees inline, ahead of the attached whole. */
const OVERSIZED_PREVIEW_CHARS = 1500;

/** oversizedPreview is the inline part of an agent message too long to send whole: its opening and a pointer to the rest. */
function oversizedPreview(content: string): string {
  return `${content.slice(0, OVERSIZED_PREVIEW_CHARS)}…\n\n[The whole message, ${content.length} characters, is attached as message.md.]`;
}

/** messageAsAttachment stores an oversized agent message whole as a Markdown file. */
function messageAsAttachment(content: string): NewAttachment {
  return {
    filename: "message.md",
    mediaType: "text/markdown",
    sizeBytes: Buffer.byteLength(content),
    textContent: content,
    data: null,
    description: null,
  };
}

async function runDispatchMessage(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = dispatchInput.parse(raw);
  if (input.handoff_id !== undefined) {
    return runSendHandoff(ctx, ctx.callerId, { ...input, handoff_id: input.handoff_id });
  }
  return (
    await deliverFromAgent(ctx, ctx.callerId, {
      to: input.to_agent_id!,
      content: input.content!,
      attachmentIds: [],
      status: input.status,
    })
  ).result;
}

/**
 * runSendHandoff sends a waiting hand-off from the agent's work lane. Its recipient,
 * files and job status come from the hand-off, so this lane cannot misaddress it or pick
 * the wrong status; a hand-off to an agent goes as written, and one to Ankur may be
 * reworded. A refused send leaves it waiting, so the lane can send it again or decline it.
 */
async function runSendHandoff(
  ctx: ToolContext,
  caller: string,
  input: { handoff_id: number; to_agent_id?: string | null | undefined; content?: string | undefined; status?: MessageStatus | undefined },
): Promise<ToolExecResult> {
  const handoff = await getHandoff(ctx.db, input.handoff_id);
  if (handoff === undefined || handoff.agentId !== caller || handoff.state !== "pending") {
    return fail(`Hand-off #${input.handoff_id} is not waiting to be sent.`);
  }
  if (input.to_agent_id !== undefined || input.status !== undefined) {
    return fail("A hand-off goes to its own recipient with the status its kind sets: leave to_agent_id and status out.");
  }
  if (input.content !== undefined && handoff.toAgentId !== null) {
    return fail("A hand-off to an agent is sent as written: leave content out, or decline_handoff with what should change.");
  }
  const sent = await deliverFromAgent(ctx, caller, {
    to: handoff.toAgentId,
    content: input.content ?? handoff.content,
    attachmentIds: handoff.attachmentIds,
    status: HANDOFF_STATUS[handoff.kind],
  });
  if (sent.row !== null) {
    await markSent(ctx.db, handoff.id, sent.row.id!, handoff.kind === "question" || handoff.kind === "request");
  }
  return sent.result;
}

/**
 * deliverFromAgent sends `from`'s message after the report gates (see jobs.ts
 * reportRefusal). A message to an agent past AGENT_MESSAGE_MAX_CHARS arrives as its
 * opening with the whole text attached as message.md.
 */
async function deliverFromAgent(
  ctx: ToolContext,
  from: string,
  message: { to: string | null; content: string; attachmentIds: string[]; status: MessageStatus | undefined },
): Promise<{ result: ToolExecResult; row: TranscriptEntry | null }> {
  if (message.to !== null) {
    await requireActiveAgent(ctx.db, message.to);
  }
  const refusal = await reportRefusal(ctx.db, from, message.to, message.status);
  if (refusal !== null) {
    return { result: fail(refusal), row: null };
  }
  const oversized = message.to !== null && message.content.length > AGENT_MESSAGE_MAX_CHARS;
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
      fromAgentId: from,
      toAgentId: message.to,
      content: oversized ? oversizedPreview(message.content) : message.content,
      attachmentIds: message.attachmentIds,
      uploads: oversized ? [messageAsAttachment(message.content)] : [],
      ...(message.status !== undefined ? { status: message.status } : {}),
      lane: ctx.lane === "work" ? "work" : "process",
    },
  );
  const attached = row.attachments.length > 0 ? { attachments: row.attachments.map(toAttachmentSummary) } : {};
  if (oversized) {
    return {
      row,
      result: ok({
        to_agent_id: row.toAgentId,
        seq: row.seq,
        delivered: true,
        ...attached,
        note: `Delivered, but at ${message.content.length} characters it passed the ${AGENT_MESSAGE_MAX_CHARS}-character limit, so the recipient got its opening and the whole text as message.md. Keep agent messages to what was found, in a few lines.`,
      }),
    };
  }
  return { row, result: ok({ to_agent_id: row.toAgentId, content: row.content, seq: row.seq, ...attached }) };
}

async function runSteerWork(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = steerInput.parse(raw ?? {});
  if (input.instruction !== undefined) {
    ctx.steer.append(ctx.callerId, input.instruction);
  }
  if (input.terminate === true) {
    ctx.steer.requestTerminate(ctx.callerId);
  }
  if (!ctx.locks.isBusy(ctx.callerId, "work")) {
    ctx.enqueueWork(ctx.callerId);
  }
  return ok({
    queued: true,
    terminate: input.terminate === true,
  });
}

/** runListAgents returns id/name/parent/retired for matching agents (global visibility). */
async function runListAgents(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  const input = listAgentsInput.parse(raw ?? {});
  const showRetired = input.show_retired ?? false;
  const conditions = [];
  if (input.id !== undefined) {
    conditions.push(eq(agents.id, input.id));
  }
  if (!showRetired) {
    conditions.push(eq(agents.active, true));
  }
  const query = ctx.db
    .select({
      id: agents.id,
      parentAgentId: agents.parentAgentId,
      description: agents.description,
      active: agents.active,
    })
    .from(agents)
    .orderBy(asc(agents.id));
  const rows =
    conditions.length === 0 ? await query : await query.where(and(...conditions));

  return ok({
    agents: rows.map((row) => ({
      id: row.id,
      name: row.id,
      parent_agent_id: row.parentAgentId,
      parent_name: row.parentAgentId,
      description: row.description,
      retired: !row.active,
    })),
  });
}
