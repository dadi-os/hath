/**
 * A job's earlier steps. A wake that continues a job (a helper's report, a reply, a reminder, a
 * timer, the requester's follow-up) starts from the thread, which holds what was said and none
 * of what was done. continuedTurns rebuilds the steps the job's earlier wakes took from the
 * agent's log, so the agent reads its own earlier calls and results instead of redoing them.
 * The wake treats them as its own steps: results past its size budget read as receipts, and
 * steps past the prompt ceiling leave behind the trimmed note (see wake.ts).
 */

import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentLogs } from "../db/schema.js";
import type { DwarProvider, DwarResponseBlock, DwarToolResultBlock, DwarToolUseBlock } from "../types/domain.js";
import type { WakeTurn } from "./wake.js";

/** What a call reads as when hath stopped before its result was logged. */
const NO_RESULT = "no result was recorded: hath stopped before this call returned";

type LoggedResponse = { provider: DwarProvider; content: DwarResponseBlock[] };

/**
 * continuedTurns is, oldest first, the model turns of the job's earlier wakes that called tools
 * (without their thinking, which a later wake does not replay), each followed by its results.
 * A turn of text alone carried no action and is left out. Empty when the job has no earlier wake.
 * `lastStepAt` is the newest log row of the job outside this wake, null when there is none: the
 * thread entries written after it are what arrived since the agent's last step.
 */
export async function continuedTurns(
  db: Db,
  args: { agentId: string; wakeId: string; jobId: string },
): Promise<{ turns: WakeTurn[]; lastStepAt: Date | null }> {
  const rows = await db
    .select({ event: agentLogs.event, payload: agentLogs.payload, createdAt: agentLogs.createdAt })
    .from(agentLogs)
    .where(
      and(
        eq(agentLogs.agentId, args.agentId),
        eq(agentLogs.jobId, args.jobId),
        sql`${agentLogs.wakeId} is distinct from ${args.wakeId}::uuid`,
      ),
    )
    .orderBy(asc(agentLogs.createdAt), asc(agentLogs.id));
  const results = new Map<string, { content: string; is_error: boolean }>();
  for (const row of rows) {
    if (row.event === "tool_result") {
      results.set(String(row.payload.tool_use_id), { content: String(row.payload.content), is_error: row.payload.is_error === true });
    }
  }
  const turns: WakeTurn[] = [];
  for (const row of rows) {
    if (row.event !== "response") {
      continue;
    }
    const response = row.payload as unknown as LoggedResponse;
    const uses = response.content.filter((block): block is DwarToolUseBlock => block.type === "tool_use");
    if (uses.length === 0) {
      continue;
    }
    turns.push({
      message: {
        role: "assistant",
        content: response.content.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking"),
        provider: response.provider,
      },
    });
    const answers: DwarToolResultBlock[] = uses.map((use) => {
      const found = results.get(use.id);
      return { type: "tool_result", tool_use_id: use.id, content: found?.content ?? NO_RESULT, is_error: found === undefined ? true : found.is_error };
    });
    turns.push({ message: { role: "user", content: answers } });
  }
  return { turns, lastStepAt: rows.at(-1)?.createdAt ?? null };
}
