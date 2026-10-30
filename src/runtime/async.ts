/**
 * Async tools. A tool is async when its definition says so (`async: true` on a registry or
 * embedded definition, or the flag its lane module exports, as memory.ts does for
 * ingest_memory); changing that is a code change. A flagged call returns `{ pending: id }` at
 * once and runs on; when it ends, its result (or its failure) reaches the agent as a message
 * that wakes its work lane, the way a helper's report does (see rewake.ts). A restart loses
 * a call still running, so each running call has a row in `pending_async`, and boot tells the
 * agent which ones were lost. Only the work lane runs tools async.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pendingAsync } from "../db/schema.js";
import { findEmbeddedTool, findTool } from "../tools/registry.js";
import { INGEST_MEMORY_ASYNC } from "./memory.js";
import { ok, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import type { DwarToolUseBlock } from "../types/domain.js";
import { INGEST_MEMORY } from "../types/domain.js";
import type { DeliverDeps } from "./deliver.js";
import { resultPath, savesResult, writeBytes } from "./files.js";
import { rewakeWork } from "./rewake.js";

/** A result longer than this reaches the agent as its opening and the path of a file holding it all. */
const INLINE_RESULT_CHARS = 4_000;

/** How much of a long result its message shows. */
const PREVIEW_CHARS = 1_500;

/** toolIsAsync is true when the tool named `name` is defined async. */
export function toolIsAsync(name: string): boolean {
  if (name === INGEST_MEMORY) {
    return INGEST_MEMORY_ASYNC;
  }
  return (findEmbeddedTool(name) ?? findTool(name))?.async === true;
}

/** deliverDeps is what delivering to the caller's thread needs, from a tool context. */
export function deliverDeps(ctx: ToolContext): DeliverDeps {
  return {
    db: ctx.db,
    transcript: ctx.transcript,
    events: ctx.events,
    enqueueProcess: ctx.enqueueProcess,
    enqueueWork: ctx.enqueueWork,
    wakeOf: ctx.wakeOf,
  };
}

/**
 * runInBackground starts `run` for the caller's call and returns `{ pending: id }` at once;
 * the call's result reaches the caller as a message when `run` settles. `run` must return
 * its outcome, never throw.
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
      await rewakeWork(deliverDeps(ctx), agentId, {
        content: await resultMessage(ctx, call, result),
        notice: "tool",
        wokenBy: `async tool result (${call.name} ${call.id})`,
      });
      await ctx.db.delete(pendingAsync).where(eq(pendingAsync.id, call.id));
    })(),
  );
  return ok({
    pending: call.id,
    note: `${call.name} is running in the background. Its result will arrive as a message that wakes you, so carry on or yield.`,
  });
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
    await rewakeWork(deps, call.agentId, {
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
