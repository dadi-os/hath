/**
 * Built-in lane tools (steer/yield/list_agents) and the executeTool dispatcher.
 * Registry tools are resolved for the work lane; the process lane's fixed tools are the
 * switch below (send, steer_work, the read tools).
 * Every lane's file tools, and the async flag, apply here (see async.ts).
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
  MESSAGE,
  MODIFY_AGENT_PROMPT,
  FIND,
  READ_FILE,
  RECALL_MEMORY,
  SEND,
  STEER_WORK,
  WAIT,
  YIELD,
} from "../types/domain.js";
import { findEmbeddedTool, findTool } from "../tools/registry.js";
import {
  fail,
  ok,
  requireActiveAgent,
  failWithoutAgentIdentity,
  type ToolContext,
  type ToolExecResult,
} from "../tools/shared.js";
import { runInBackground, toolIsAsync } from "./async.js";
import { KEEP_WHOLE_CHARS } from "./wake.js";
import { resultPath, savesResult, writeBytes } from "./files.js";
import { runWait } from "./watches.js";
import { runMessage } from "./outbox.js";
import { runIngestMemory, runRecallMemory } from "./memory.js";
import { runManageAgent, runModifyAgentPrompt } from "./modify.js";
import { runRouterTool } from "./router.js";
import { runSend } from "./send.js";

/** The embedded registry tools the process lane holds besides its own: reads of the logs and the web. */
export const PROCESS_REGISTRY_TOOLS = ["get_logs", "web_search", "web_fetch"] as const;

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
    if (call.name === READ_FILE || (call.name === FIND && ctx.lane !== "router")) {
      const reader = findEmbeddedTool(call.name);
      if (!reader) {
        throw new Error(`${call.name} is not registered`);
      }
      return await reader.handler(ctx, reader.input.parse(call.input));
    }
    if (ctx.lane === "router") {
      return await runRouterTool(ctx, call);
    }
    if (ctx.lane === "work") {
      if (call.name === MESSAGE) {
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
      }
      const parsed = definition.input.parse(call.input);
      return await definition.handler(ctx, parsed);
    }
    switch (call.name) {
      case SEND:
        return await runSend(ctx, call.input);
      case STEER_WORK:
        return await runSteerWork(ctx, call.input);
      case RECALL_MEMORY:
        return await runRecallMemory(ctx, call.input);
      default: {
        const registry = (PROCESS_REGISTRY_TOOLS as readonly string[]).includes(call.name) ? findEmbeddedTool(call.name) : undefined;
        if (registry) {
          return await registry.handler(ctx, registry.input.parse(call.input));
        }
        return fail(
          `${call.name} is not a process-lane tool. Yours are ${SEND}, ${STEER_WORK}, ${READ_FILE}, ${FIND}, get_logs, ${RECALL_MEMORY}, web_search, web_fetch, ${LIST_AGENTS} and ${YIELD}. Every other tool this agent holds runs in the work lane: call ${STEER_WORK} with what you need done.`,
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
