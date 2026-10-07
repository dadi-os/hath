/**
 * Built-in lane tools (send/dispatch/steer/yield/list_agents) and the executeTool dispatcher.
 * Registry tools are resolved for the reasoning lane; conversation uses the switch below.
 */

import { and, asc, eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { agentIdOrUserSchema, agentIdSchema } from "../agent-id.js";
import { agents } from "../db/schema.js";
import { HathError } from "../errors.js";
import type { DwarTool, DwarToolUseBlock } from "../types/domain.js";
import {
  DISPATCH_MESSAGE,
  INGEST_MEMORY,
  LIST_AGENTS,
  MANAGE_AGENT,
  MODIFY_AGENT_PROMPT,
  RECALL_MEMORY,
  SEND_MESSAGE,
  STEER_REASONING,
  WAIT,
  YIELD,
} from "../types/domain.js";
import { findEmbeddedTool, findTool } from "../tools/registry.js";
import {
  fail,
  ok,
  requireAgent,
  requireActiveAgent,
  requireToolGrant,
  failWithoutAgentIdentity,
  type ToolContext,
  type ToolExecResult,
} from "../tools/shared.js";
import { deliverAgentMessage } from "./deliver.js";
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
      description: "Recipient kebab-case agent id, or null for the user",
    },
    intent: {
      type: "string",
      description: "What you want said, not the final wording",
    },
  },
  required: ["to_agent_id", "intent"],
};

export const dispatchMessageInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    to_agent_id: {
      type: ["string", "null"],
      description: "Recipient kebab-case agent id, or null for the user",
    },
    content: { type: "string", description: "The message to persist and deliver" },
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

/** Upper bound on a single in-lane wait; longer or cross-agent delays use scheduling. */
export const WAIT_MAX_SECONDS = 300;

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

/** Hand intent to conversation; does not persist a message. */
export const sendMessageTool: DwarTool = {
  name: SEND_MESSAGE,
  description:
    "Hand an intent to your conversation lane so it can compose and dispatch a message. Does not send anything itself. to_agent_id null is the user. See the routing block for who to address. Report real tool errors honestly; do not invent that grants are missing.",
  input_schema: sendMessageInputSchema,
};

/** Persist and deliver a message to another agent or the user. */
export const dispatchMessageTool: DwarTool = {
  name: DISPATCH_MESSAGE,
  description:
    "Write a message to another agent or to the user (to_agent_id null). This is the only way a message addressed to someone else is persisted. Does not end the turn — call yield when done. See the routing block for who to address. Domain work runs on the reasoning lane — use steer_reasoning for that; do not claim grants are missing because conversation cannot see them.",
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
    "Pause your reasoning lane for a number of seconds, then resume automatically where you left off. Use when you must wait for something to settle — a page to load, a job or another agent to finish, a reply you expect shortly — instead of burning turns polling. Unlike yield, this does NOT end your turn: reasoning continues after the pause with no model calls spent while waiting. Unlike schedule_message, it waits here rather than sending a message to another agent later. A steer, a terminate, or a new message to you cuts the wait short, so waiting on a reply returns as soon as it lands. Max " +
    `${WAIT_MAX_SECONDS}s; for longer or cross-agent delays, use scheduling.`,
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
  intent: z.string().min(1),
});

const dispatchInput = z.object({
  to_agent_id: agentIdOrUserSchema,
  content: z.string().min(1),
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
      case STEER_REASONING:
        return await runSteerReasoning(ctx, call.input);
      default:
        return fail(`unknown conversation tool: ${call.name}`);
    }
  } catch (err) {
    if (err instanceof ZodError) {
      return fail(err.issues.map((issue) => issue.message).join("; "));
    }
    return unexpectedToolError(err);
  }
}

/**
 * Pause the reasoning lane in place, polling so a steer, a terminate, or a new
 * message to the agent cuts the wait short. No model calls run while waiting;
 * the loop resumes on return and the next step folds in what arrived.
 */
async function runWait(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = waitInput.parse(raw);
  const agentId = ctx.callerId;
  const totalMs = input.seconds * 1000;
  const deadline = Date.now() + totalMs;
  const inboundAtStart = ctx.transcript.lastInboundSeq(agentId);
  while (Date.now() < deadline) {
    if (
      ctx.steer.isTerminate(agentId) ||
      ctx.steer.hasItems(agentId) ||
      ctx.transcript.lastInboundSeq(agentId) > inboundAtStart
    ) {
      return ok({ waited_seconds: Math.round((totalMs - (deadline - Date.now())) / 1000), interrupted: true });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_POLL_MS, deadline - Date.now())));
  }
  return ok({ waited_seconds: input.seconds, interrupted: false });
}

async function runSendMessage(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = sendInput.parse(raw);
  if (input.to_agent_id !== null) {
    await requireActiveAgent(ctx.db, input.to_agent_id);
  }
  ctx.intents.append(ctx.callerId, { toAgentId: input.to_agent_id, intent: input.intent });
  ctx.enqueueConversation(ctx.callerId);
  return ok({ handed_off: true });
}

async function runDispatchMessage(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = dispatchInput.parse(raw);
  if (input.to_agent_id !== null) {
    await requireActiveAgent(ctx.db, input.to_agent_id);
  }
  const row = await deliverAgentMessage(
    {
      db: ctx.db,
      transcript: ctx.transcript,
      events: ctx.events,
      enqueueConversation: ctx.enqueueConversation,
    },
    {
      fromAgentId: ctx.callerId,
      toAgentId: input.to_agent_id,
      content: input.content,
    },
  );
  return ok({ to_agent_id: row.toAgentId, content: row.content, seq: row.seq });
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
