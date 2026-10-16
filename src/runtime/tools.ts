/**
 * Built-in lane tools (send/dispatch/steer/yield/list_agents) and the executeTool dispatcher.
 * Registry tools are resolved for the reasoning lane; conversation uses the switch below.
 */

import { and, asc, eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { agentIdOrUserSchema, agentIdSchema } from "../agent-id.js";
import { agents } from "../db/schema.js";
import { HathError } from "../errors.js";
import type { DwarTool, DwarToolUseBlock, MessageStatus } from "../types/domain.js";
import {
  CREATE_ATTACHMENT,
  DISPATCH_MESSAGE,
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
  STEER_REASONING,
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
      type: ["string", "null"],
      description: 'Recipient kebab-case agent id, or null for Ankur (the user); never the string "Ankur"',
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
    status: {
      type: "string",
      enum: [...MESSAGE_STATUSES],
      description: STATUS_DESCRIPTION,
    },
  },
  required: ["to_agent_id", "content"],
};

export const dispatchMessageInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    to_agent_id: {
      type: ["string", "null"],
      description: 'Recipient kebab-case agent id, or null for Ankur (the user); never the string "Ankur"',
    },
    content: { type: "string", description: "The message to persist and deliver" },
    status: {
      type: "string",
      enum: [...MESSAGE_STATUSES],
      description: STATUS_DESCRIPTION,
    },
  },
  required: ["to_agent_id", "content"],
};

export const steerReasoningInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    instruction: {
      type: "string",
      description:
        "What reasoning should do next. Omit when terminate is true and you only need to halt.",
    },
    terminate: {
      type: "boolean",
      description:
        "When true, stop the reasoning lane in its tracks: the next tool call does not run. Use for stop/kill. Can combine with instruction.",
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
 * unrelated arrival that cut one short cost a full reasoning call.
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
      description: `How long to pause before reasoning resumes, 1–${WAIT_MAX_SECONDS}s`,
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

/** Persist and deliver a message from the reasoning lane. */
export const sendMessageTool: DwarTool = {
  name: SEND_MESSAGE,
  description:
    "Send a message to another agent or to the user (to_agent_id null). It is delivered as you write it, when the call returns, and wakes its recipient. To send files, list their ids in attachment_ids (create_attachment turns a host file into one) instead of pasting their contents. A message to whoever gave you a job that is still open carries a status (see the [Open jobs] note); hath refuses one without it, a second progress update, and a second question before their reply, and the refusal says how to send it again. Does not end the turn: to wait for a reply, yield, and the reply wakes you. Report real tool errors honestly; do not invent that grants are missing.",
  input_schema: sendMessageInputSchema,
};

/** Persist and deliver a message to another agent or the user. */
export const dispatchMessageTool: DwarTool = {
  name: DISPATCH_MESSAGE,
  description:
    "Write a message to another agent or to the user (to_agent_id null). This is the only way a message addressed to someone else is persisted. Does not end the turn — call yield when done. Hath refuses a send that breaks one of these, so follow them the first time: one message per recipient per turn, text and files together (forward_attachment carries both); a message to whoever gave you a job that is still open carries a status (see the [Open jobs] note); an agent you gave work to hears only from your reasoning lane, which sends it everything itself, so steer reasoning to change that work; and a send to someone who wrote after you composed it waits until you have read them. See the routing block for who to address. Domain work runs on the reasoning lane — use steer_reasoning for that; do not claim grants are missing because conversation cannot see them.",
  input_schema: dispatchMessageInputSchema,
};

/** Queue an instruction for the caller's reasoning lane. */
export const steerReasoningTool: DwarTool = {
  name: STEER_REASONING,
  description:
    "Direct your reasoning lane. You manage reasoning from conversation: pass instruction for what it should do next (domain tools run there), and/or terminate true to halt it immediately so the next tool call does not run. Starts a reasoning wake if that lane is idle. Use terminate for stop/kill.",
  input_schema: steerReasoningInputSchema,
};

/** End the current lane turn. */
export const yieldTool: DwarTool = {
  name: YIELD,
  description:
    "End this lane turn. Call when you have nothing more to do right now. Sending a message or running other tools does not end the turn — only yield does.",
  input_schema: yieldInputSchema,
};

/** Pause the reasoning lane in place for a set duration, then resume. */
export const waitTool: DwarTool = {
  name: WAIT,
  description:
    "Pause your reasoning lane for a few seconds while something you started settles (a command finishing, a file landing), then resume where you left off. Never wait for a person or an agent: yield instead, and their reply wakes you. For a page to load or change, use browser_wait_for. A steer, a terminate, or a new message to you cuts the wait short. Max " +
    `${WAIT_MAX_SECONDS}s; for a later time, use scheduling.`,
  input_schema: waitInputSchema,
};

/** Look up agents by exact id or list the roster (id, name alias, parent, retired). */
export const listAgentsTool: DwarTool = {
  name: LIST_AGENTS,
  description:
    "List agents visible to you: id, name (alias of id), parent, and whether each is retired. Retired agents are left out unless show_retired is true. Pass id for an exact kebab-case lookup (empty list on miss, including a retired id without show_retired).",
  input_schema: listAgentsInputSchema,
};

const sendInput = z.object({
  to_agent_id: agentIdOrUserSchema,
  content: z.string().min(1),
  attachment_ids: z
    .array(z.string().uuid())
    .max(MAX_ATTACHMENTS)
    .refine((ids) => new Set(ids).size === ids.length, "attachment_ids must not repeat")
    .optional(),
  status: z.enum(MESSAGE_STATUSES).optional(),
});

const dispatchInput = z.object({
  to_agent_id: agentIdOrUserSchema,
  content: z.string().min(1),
  status: z.enum(MESSAGE_STATUSES).optional(),
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
    ctx.sessions.observe(ctx.callerId, call.name, call.input, result.isError);
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
    if (ctx.lane === "reasoning") {
      if (call.name === SEND_MESSAGE) {
        return await runSendMessage(ctx, call.input);
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
        return fail(`unknown reasoning tool: ${call.name}`);
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
      case STEER_REASONING:
        return await runSteerReasoning(ctx, call.input);
      default:
        return fail(
          `${call.name} is not a conversation tool. Yours are ${DISPATCH_MESSAGE}, ${FORWARD_ATTACHMENT}, ${READ_ATTACHMENT}, ${STEER_REASONING}, ${LIST_AGENTS} and ${YIELD}. Every other tool this agent holds, ${call.name} included if it is granted, runs in the reasoning lane: call ${STEER_REASONING} with what you need done.`,
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
 * Pause the reasoning lane in place for a short settle, polling so a steer, a terminate,
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
 * runSendMessage delivers the reasoning lane's message as written: the lane that did the
 * work writes the message, and a refusal (a missing status, a spent progress update) comes
 * back to it, since it is the one that can fix it. The conversation lane used to compose
 * each one again from a hand-off, which on 2026-10-14 to 2026-10-16 refused 81 of 855
 * sends, rewrote others, and left the reasoning lane waiting on messages never sent.
 */
async function runSendMessage(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = sendInput.parse(raw);
  const attachmentIds = input.attachment_ids ?? [];
  await requireAttachments(ctx.db, attachmentIds);
  return deliverFromAgent(ctx, ctx.callerId, {
    to: input.to_agent_id,
    content: input.content,
    attachmentIds,
    status: input.status,
  });
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
  return deliverFromAgent(ctx, ctx.callerId, {
    to: input.to_agent_id,
    content: input.content,
    attachmentIds: [],
    status: input.status,
  });
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
): Promise<ToolExecResult> {
  if (message.to !== null) {
    await requireActiveAgent(ctx.db, message.to);
  }
  const refusal = await reportRefusal(ctx.db, from, message.to, message.status);
  if (refusal !== null) {
    return fail(refusal);
  }
  const oversized = message.to !== null && message.content.length > AGENT_MESSAGE_MAX_CHARS;
  const row = await deliverAgentMessage(
    {
      db: ctx.db,
      transcript: ctx.transcript,
      events: ctx.events,
      enqueueConversation: ctx.enqueueConversation,
      enqueueReasoning: ctx.enqueueReasoning,
      wakeOf: ctx.wakeOf,
    },
    {
      fromAgentId: from,
      toAgentId: message.to,
      content: oversized ? oversizedPreview(message.content) : message.content,
      attachmentIds: message.attachmentIds,
      uploads: oversized ? [messageAsAttachment(message.content)] : [],
      ...(message.status !== undefined ? { status: message.status } : {}),
      lane: ctx.lane === "reasoning" ? "reasoning" : "conversation",
    },
  );
  const attached = row.attachments.length > 0 ? { attachments: row.attachments.map(toAttachmentSummary) } : {};
  if (oversized) {
    return ok({
      to_agent_id: row.toAgentId,
      seq: row.seq,
      delivered: true,
      ...attached,
      note: `Delivered, but at ${message.content.length} characters it passed the ${AGENT_MESSAGE_MAX_CHARS}-character limit, so the recipient got its opening and the whole text as message.md. Keep agent messages to what was found, in a few lines.`,
    });
  }
  return ok({ to_agent_id: row.toAgentId, content: row.content, seq: row.seq, ...attached });
}

async function runSteerReasoning(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
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
  if (!ctx.locks.isBusy(ctx.callerId, "reasoning")) {
    ctx.enqueueReasoning(ctx.callerId);
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
      retired: !row.active,
    })),
  });
}
