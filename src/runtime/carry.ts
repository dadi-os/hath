/**
 * Work carried across a job's wakes. Each follow-up wake of a job (a helper's report, a wait
 * that timed out) starts from the thread alone, which holds what was said and none of what
 * was done, so the lane re-ran calls its last wake had made. `runtime.job_did_carry` gives
 * such a wake a block listing the job's earlier tool calls.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentLogs, jobs, messages } from "../db/schema.js";
import { WAIT, YIELD } from "../types/domain.js";
import { resultPath, savesResult } from "./files.js";
import type { TranscriptStore } from "./transcript.js";
import { KEEP_WHOLE_CHARS } from "./wake.js";

/** The block's size: the newest calls that fit are kept. */
export const DID_MAX_CHARS = 4_000;

/** How much of a call's input a line shows. */
const INPUT_CHARS = 120;

/** How much of a call's result a line shows. */
const RESULT_CHARS = 160;

/** The block's heading, which work.txt names. */
export const DID_HEADING = "[Did in this job]";

type LogRow = {
  event: string;
  tool_use_id: string | null;
  name: string | null;
  head: string | null;
  chars: number | null;
  is_error: string | null;
  uses: Array<{ id: string; name: string; input: string }> | null;
};

/**
 * jobStart is when the work `agentId`'s current wake continues began: its routine's trigger
 * when the wake is a routine (`routineSeq`), else the opening message of its newest open job,
 * whoever gave it. Null when it has neither.
 */
async function jobStart(db: Db, transcript: TranscriptStore, agentId: string, routineSeq: number | null): Promise<Date | null> {
  if (routineSeq !== null) {
    return transcript.transcriptFor(agentId).find((row) => row.seq === routineSeq)?.createdAt ?? null;
  }
  const [job] = await db
    .select({ openedSeq: jobs.openedSeq })
    .from(jobs)
    .where(and(eq(jobs.agentId, agentId), inArray(jobs.state, ["open", "needs_input"])))
    .orderBy(desc(jobs.openedSeq))
    .limit(1);
  if (job === undefined) {
    return null;
  }
  const [opening] = await db.select({ at: messages.createdAt }).from(messages).where(eq(messages.seq, job.openedSeq));
  return opening?.at ?? null;
}

/** oneLine is `text` on one line, cut to `max` characters. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * carriedWork is the [Did in this job] block for `agentId`'s wake `wakeId`: one line per tool
 * call its work lane made in the job's earlier wakes (name, the start of its input, and its
 * result's start, with the file holding a long result whole), oldest first, within
 * DID_MAX_CHARS. Null when the agent has no job or routine to carry, or made no call in it.
 */
export async function carriedWork(
  db: Db,
  transcript: TranscriptStore,
  args: { agentId: string; wakeId: string; routineSeq: number | null; filesDir: string },
): Promise<string | null> {
  const since = await jobStart(db, transcript, args.agentId, args.routineSeq);
  if (since === null) {
    return null;
  }
  const rows = await db.execute<LogRow>(sql`
    select event,
      payload->>'tool_use_id' as tool_use_id,
      payload->>'name' as name,
      left(payload->>'content', ${RESULT_CHARS}) as head,
      length(payload->>'content') as chars,
      payload->>'is_error' as is_error,
      case when event = 'response' then (
        select coalesce(jsonb_agg(jsonb_build_object('id', b->>'id', 'name', b->>'name', 'input', left((b->'input')::text, ${INPUT_CHARS}))), '[]'::jsonb)
        from jsonb_array_elements(payload->'content') b
        where b->>'type' = 'tool_use'
      ) end as uses
    from ${agentLogs}
    where agent_id = ${args.agentId} and lane = 'work' and event in ('response', 'tool_result')
      and created_at >= ${since.toISOString()}::timestamptz
      and wake_id is distinct from ${args.wakeId}::uuid
    order by created_at, id
  `);
  const inputs = new Map<string, string>();
  const lines: string[] = [];
  for (const row of rows) {
    for (const use of row.uses ?? []) {
      inputs.set(use.id, use.input);
    }
    if (row.event !== "tool_result" || row.name === null || row.name === YIELD || row.name === WAIT) {
      continue;
    }
    const failed = row.is_error === "true" ? "failed: " : "";
    const receipt =
      row.tool_use_id !== null && Number(row.chars) > KEEP_WHOLE_CHARS && savesResult(row.name)
        ? ` [whole result: ${resultPath(args.filesDir, row.tool_use_id)}]`
        : "";
    const input = inputs.get(row.tool_use_id ?? "");
    lines.push(`- ${row.name}${input === undefined ? "" : ` ${oneLine(input, INPUT_CHARS)}`} -> ${failed}${oneLine(row.head ?? "", RESULT_CHARS)}${receipt}`);
  }
  const kept: string[] = [];
  let size = DID_HEADING.length;
  for (const line of lines.reverse()) {
    size += line.length + 1;
    if (size > DID_MAX_CHARS) {
      break;
    }
    kept.unshift(line);
  }
  return kept.length === 0 ? null : [DID_HEADING, ...kept].join("\n");
}
