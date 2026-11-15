/**
 * The tools yield and list_agents, and the executeTool dispatcher. Registry tools resolve through
 * agentRegistryTool (tool-set.ts, which also declares the whole tool set); the async flag applies
 * here (see async.ts).
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
  MODIFY_AGENT_PROMPT,
  RECALL_MEMORY,
  SEND_MESSAGE,
  YIELD,
} from "../types/domain.js";
import { agentRegistryTool } from "./tool-set.js";
import {
  fail,
  ok,
  requireActiveAgent,
  type ToolContext,
  type ToolExecResult,
} from "../tools/shared.js";
import { cutLong } from "./async.js";
import { KEEP_WHOLE_CHARS } from "./wake.js";
import { resultPath, savesResult, writeBytes } from "./files.js";
import { runIngestMemory, runRecallMemory } from "./memory.js";
import { recallDigestRow, recordActivity, storeRow } from "./activity.js";
import { runManageAgent, runModifyAgentPrompt } from "./modify.js";
import { runRouterTool } from "./router.js";
import { runSend } from "./send.js";

export type { ToolContext, ToolExecResult } from "../tools/shared.js";
export { requireAgent, requireActiveAgent } from "../tools/shared.js";

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

/** End the run. */
export const yieldTool: DwarTool = {
  name: YIELD,
  description:
    "End this run. Call when you have nothing more to do right now. Sending a message or running other tools does not end the run by itself; yield does.",
  input_schema: yieldInputSchema,
};

/** Look up agents by exact id or list the roster (id, name alias, parent, retired). */
export const listAgentsTool: DwarTool = {
  name: LIST_AGENTS,
  description:
    "List agents visible to you: id, name (alias of id), parent, directory description (null for workers and agents that set none), and whether each is retired. Retired agents are left out unless show_retired is true. Pass id for an exact kebab-case lookup (empty list on miss, including a retired id without show_retired).",
  input_schema: listAgentsInputSchema,
};

const yieldInput = z.object({}).strict();

const listAgentsInput = z
  .object({
    id: agentIdSchema.optional(),
    show_retired: z.boolean().optional(),
  })
  .strict();

/** Map an unexpected throw into a tool error so the transcript stays valid. */
export function unexpectedToolError(err: unknown): ToolExecResult {
  if (err instanceof HathError) {
    return fail(`${err.type}: ${err.message}`);
  }
  if (err instanceof Error) {
    return fail(err.message);
  }
  return fail(String(err));
}

/** Dispatch a tool_use block for the caller; map Zod/4xx to tool errors.
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
  let result = await saveLargeResult(ctx, call, await run());
  const whole = result.content;
  if (call.name === INGEST_MEMORY) {
    result = cutLong(ctx, call, result);
  }
  if (ctx.callerId !== null) {
    ctx.toolDebounce.record(ctx.callerId, result.isError);
    if (!result.isError && ctx.callerKind === "agent") {
      await recordToolActivity(ctx, call, whole);
    }
  }
  return result;
}

/**
 * recordToolActivity writes the activity row a successful call earns, from its whole result: what an
 * ingest stored, and the tasks a recall by date returned. Sends, routines and reminders record
 * themselves; a helper's read is recorded when its report arrives (see helper-reports.ts).
 */
async function recordToolActivity(ctx: ToolContext, call: DwarToolUseBlock, whole: string): Promise<void> {
  const callerId = ctx.callerId!;
  const row =
    call.name === INGEST_MEMORY
      ? storeRow(whole)
      : call.name === RECALL_MEMORY
        ? recallDigestRow(call.input as { relevant_on?: string }, whole)
        : null;
  if (row !== null) {
    await recordActivity(ctx.db, { agentId: callerId, jobId: ctx.jobId, ...row });
  }
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
    if (ctx.callerKind === "router") {
      return await runRouterTool(ctx, call);
    }
    if (call.name === SEND_MESSAGE) {
      return await runSend(ctx, call.input);
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
    const definition = agentRegistryTool(call.name);
    if (!definition) {
      return fail(`unknown tool: ${call.name}`);
    }
    if (ctx.callerId !== null) {
      await requireActiveAgent(ctx.db, ctx.callerId);
    }
    return await definition.handler(ctx, definition.input.parse(call.input));
  } catch (err) {
    if (err instanceof ZodError) {
      return fail(err.issues.map((issue) => issue.message).join("; "));
    }
    return unexpectedToolError(err);
  }
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
