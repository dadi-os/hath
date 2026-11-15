/**
 * Background calls. A tool whose service decides a request is too slow to wait for
 * (control_device) returns `{ pending: id }` at once and runs on; when it ends, its result (or
 * its failure) reaches the agent as a message that wakes it, the way a helper's report does (see
 * rewake.ts). A restart loses a call still running, so each running call has a row in
 * `pending_async`, and boot tells the agent which ones were lost.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pendingAsync } from "../db/schema.js";
import { ok, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import type { DwarToolUseBlock } from "../types/domain.js";
import type { DeliverDeps } from "./deliver.js";
import { resultPath, savesResult, writeBytes } from "./files.js";
import { rewake } from "./rewake.js";

/** A result longer than this reaches the agent as its opening and the path of a file holding it all. */
const INLINE_RESULT_CHARS = 4_000;

/** How much of a long result its message shows. */
const PREVIEW_CHARS = 1_500;

/** deliverDeps is what delivering to the caller's thread needs, from a tool context. */
export function deliverDeps(ctx: ToolContext): DeliverDeps {
  return {
    db: ctx.db,
    transcript: ctx.transcript,
    events: ctx.events,
    enqueue: ctx.enqueue,
    preempt: ctx.preempt,
    answerByMinutes: ctx.answerByMinutes,
    ...(ctx.wakeActivity !== undefined ? { wakeActivity: ctx.wakeActivity } : {}),
  };
}

/**
 * runInBackground starts `run` for the caller's call and returns `{ pending: id }` at once;
 * the call's result reaches the caller as a message that wakes it when `run` settles. `run`
 * must return its outcome, never throw.
 */
export async function runInBackground(
  ctx: ToolContext,
  agentId: string,
  call: DwarToolUseBlock,
  run: () => Promise<ToolExecResult>,
): Promise<ToolExecResult> {
  await ctx.db.insert(pendingAsync).values({ id: call.id, agentId, toolName: call.name });
  ctx.background(
    (async () => {
      const result = await run();
      const content = await resultMessage(ctx, call, result);
      await rewake(deliverDeps(ctx), agentId, { content, notice: "tool", wokenBy: `async tool result (${call.name} ${call.id})`, jobId: ctx.jobId });
      await ctx.db.delete(pendingAsync).where(eq(pendingAsync.id, call.id));
    })(),
  );
  return ok({
    pending: call.id,
    note: `${call.name} is running in the background. Its result will arrive as a message that wakes you, so carry on or yield.`,
  });
}

/**
 * cutLong is `result` as the agent reads a sync call that may be long: one over
 * INLINE_RESULT_CHARS shows its opening and the path of the file holding it whole (saved by
 * executeTool), as an async result does. A result whose file could not be written is left whole.
 */
export function cutLong(ctx: ToolContext, call: DwarToolUseBlock, result: ToolExecResult): ToolExecResult {
  if (result.content.length <= INLINE_RESULT_CHARS || result.audit.result_file_failed !== undefined) {
    return result;
  }
  const path = resultPath(ctx.files.dir, call.id);
  return { ...result, content: `${result.content.slice(0, PREVIEW_CHARS)}…\n[${result.content.length} characters in all; the whole result is saved at ${path}: read_file it.]` };
}

/** resultMessage is what the agent reads when an async call ends. */
async function resultMessage(ctx: ToolContext, call: DwarToolUseBlock, result: ToolExecResult): Promise<string> {
  const head = `Result of ${call.name} (${call.id}), ${result.isError ? "failed" : "done"}:`;
  if (result.content.length <= INLINE_RESULT_CHARS || !savesResult(call.name)) {
    return `${head}\n${result.content}`;
  }
  const path = resultPath(ctx.files.dir, call.id);
  await writeBytes(ctx.files, path, Buffer.from(result.content, "utf8"));
  return `${head}\n${result.content.slice(0, PREVIEW_CHARS)}…\n[${result.content.length} characters in all; the whole result is saved at ${path}: read_file it.]`;
}

/**
 * reportLostAsync tells each agent whose async call a restart cut short that its result
 * will not come, and clears the call. Run once at boot.
 */
export async function reportLostAsync(deps: DeliverDeps): Promise<number> {
  const lost = await deps.db.select().from(pendingAsync);
  for (const call of lost) {
    await rewake(deps, call.agentId, {
      content: `Result of ${call.toolName} (${call.id}) lost: hath restarted while it was running, so it may or may not have taken effect. Check what it was for, and run it again if it still matters.`,
      notice: "tool",
      wokenBy: `async tool result lost in a restart (${call.toolName} ${call.id})`,
    });
    await deps.db.delete(pendingAsync).where(eq(pendingAsync.id, call.id));
  }
  return lost.length;
}

/** hasPendingAsync is true when `agentId` has an async call still running. */
export async function hasPendingAsync(db: Db, agentId: string): Promise<boolean> {
  const rows = await db.select({ id: pendingAsync.id }).from(pendingAsync).where(eq(pendingAsync.agentId, agentId)).limit(1);
  return rows.length > 0;
}
