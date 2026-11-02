/**
 * The lane tools steer_work, yield and list_agents, and the executeTool dispatcher. A lane's
 * registry tools resolve through laneRegistryTool (lanes.ts, which also declares each lane's
 * whole tool set); the async flag applies here (see async.ts).
 */

import { and, asc, eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { agentIdSchema } from "../agent-id.js";
import { agents } from "../db/schema.js";
import { HathError } from "../errors.js";
import type { DwarTool, DwarToolUseBlock } from "../types/domain.js";
import {
  INGEST_MEMORY,
  LIST_AGENTS,
  MANAGE_AGENT,
  QUEUE_MESSAGE,
  MODIFY_AGENT_PROMPT,
  RECALL_MEMORY,
  SEND_MESSAGE,
  STEER_WORK,
  WAIT,
  YIELD,
} from "../types/domain.js";
import { laneRegistryTool, toolsForLane } from "./lanes.js";
import {
  fail,
  ok,
  requireActiveAgent,
  failWithoutAgentIdentity,
  type ToolContext,
  type ToolExecResult,
} from "../tools/shared.js";
import { deliverDeps, runInBackground, toolIsAsync } from "./async.js";
import { deliverAgentMessage } from "./deliver.js";
import { ACTION_TOOLS } from "./record.js";
import { shortArg } from "./status.js";
import { KEEP_WHOLE_CHARS } from "./wake.js";
import { resultPath, savesResult, writeBytes } from "./files.js";
import { runWait } from "./watches.js";
import { runMessage } from "./outbox.js";
import { runIngestMemory, runRecallMemory } from "./memory.js";
import { runManageAgent, runModifyAgentPrompt } from "./modify.js";
import { runRouterTool } from "./router.js";
import { runSend } from "./send.js";

export type { ToolContext, ToolExecResult } from "../tools/shared.js";
export { requireAgent, requireActiveAgent } from "../tools/shared.js";

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

/** Look up agents by exact id or list the roster (id, name alias, parent, retired). */
export const listAgentsTool: DwarTool = {
  name: LIST_AGENTS,
  description:
    "List agents visible to you: id, name (alias of id), parent, directory description (null for workers and agents that set none), and whether each is retired. Retired agents are left out unless show_retired is true. Pass id for an exact kebab-case lookup (empty list on miss, including a retired id without show_retired).",
  input_schema: listAgentsInputSchema,
};

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
  const run = async (): Promise<ToolExecResult> => {
    try {
      return await dispatchTool({ ...ctx, callId: call.id }, call);
    } catch (err) {
      return unexpectedToolError(err);
    }
  };
  let result: ToolExecResult;
  if (ctx.lane === "work" && ctx.callerId !== null && call.name !== YIELD && call.name !== WAIT && toolIsAsync(call.name)) {
    result = await runInBackground(ctx, ctx.callerId, call, run);
  } else {
    result = await saveLargeResult(ctx, call, await run());
  }
  if (ctx.callerId !== null) {
    ctx.toolDebounce.record(ctx.callerId, result.isError);
  }
  return result;
}

/**
 * saveLargeResult writes a long result to its file on the box (see files.ts), whole as the
 * tool stored it, because the wake's receipts for it name that path. A failed write is
 * recorded on the result and does not fail the call.
 */
async function saveLargeResult(ctx: ToolContext, call: DwarToolUseBlock, result: ToolExecResult): Promise<ToolExecResult> {
  const whole = typeof result.audit.full === "string" ? result.audit.full : result.content;
  if (ctx.callerId === null || !savesResult(call.name) || whole.length <= KEEP_WHOLE_CHARS) {
    return result;
  }
  try {
    await writeBytes(ctx.files, resultPath(ctx.files.dir, call.id), Buffer.from(whole, "utf8"));
    return result;
  } catch (err) {
    return { ...result, audit: { ...result.audit, result_file_failed: err instanceof Error ? err.message : String(err) } };
  }
}

/** Route one tool_use to the matching handler. */
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
    if (ctx.lane === "work") {
      if (call.name === QUEUE_MESSAGE) {
        return await runMessage(ctx, call.input);
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
      const definition = laneRegistryTool("work", call.name);
      if (!definition) {
        return fail(`unknown work-lane tool: ${call.name}`);
      }
      if (ctx.callerId !== null) {
        await requireActiveAgent(ctx.db, ctx.callerId);
      }
      return await definition.handler(ctx, definition.input.parse(call.input));
    }
    switch (call.name) {
      case SEND_MESSAGE:
        return await runSend(ctx, call.input);
      case STEER_WORK:
        return await runSteerWork(ctx, call.input);
      case RECALL_MEMORY:
        return await runRecallMemory(ctx, call.input);
      default: {
        const registry = laneRegistryTool("process", call.name);
        if (registry) {
          const result = await registry.handler(ctx, registry.input.parse(call.input));
          await noteProcessAction(ctx, call, result);
          return result;
        }
        return fail(
          `${call.name} is not a process-lane tool. Yours are ${toolsForLane(ctx.callerId, "process").map((tool) => tool.name).join(", ")}. Every other tool this agent holds runs in the work lane: call ${STEER_WORK} with what you need done.`,
        );
      }
    }
  } catch (err) {
    if (err instanceof ZodError) {
      return fail(err.issues.map((issue) => issue.message).join("; "));
    }
    return unexpectedToolError(err);
  }
}

/** How much of an action's result its note keeps. */
const ACTION_NOTE_RESULT_CHARS = 200;

/**
 * noteProcessAction tells the work lane what the process lane just did to the world: the
 * work lane never sees the process lane's calls, so a successful action is recorded as a
 * note from hath to the agent, delivered without waking anyone, which both lanes read among
 * their next arrivals.
 */
async function noteProcessAction(ctx: ToolContext, call: DwarToolUseBlock, result: ToolExecResult): Promise<void> {
  if (ctx.callerId === null || result.isError || !ACTION_TOOLS.has(call.name)) {
    return;
  }
  await deliverAgentMessage(deliverDeps(ctx), {
    fromAgentId: ctx.callerId,
    toAgentId: ctx.callerId,
    content: `Your process lane ran ${call.name} ${shortArg(call.input)}: ${result.content.slice(0, ACTION_NOTE_RESULT_CHARS)}`,
    notice: "tool",
    wake: false,
    lane: "process",
  });
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
