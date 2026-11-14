import type { ToolExecResult } from "../tools/shared.js";
import type { DwarResponseBlock, DwarToolUseBlock } from "../types/domain.js";
import { SEND_MESSAGE, STEER_WORK } from "../types/domain.js";
import { callLane, laneRequest, runStep, syncWake, type StepDeps } from "./step.js";
import type { TranscriptStore } from "./transcript.js";

/** Step deps plus the status block's renderer. */
export type ProcessLoopDeps = StepDeps & {
  /** The status block for the next call (see status.ts). */
  status: () => Promise<string>;
  /** `runtime.implicit_yield`: a turn of only successful sends and steers ends the run (see endsOnItsOwn). */
  implicitYield: boolean;
  /** The agent's transcript, to see whether anything arrived after a turn was composed. */
  transcript: TranscriptStore;
};

/**
 * Process-lane loop: the front desk. Its view is its system, its own turns, what arrived,
 * and hath's status block as the last turn of every call (see status.ts); the work lane's
 * thinking, tool calls and results are not in it. It speaks with `send_message`, like every lane.
 * A turn with no tool call continues; the only clean exit is the yield tool.
 * Skips the provider call when the visible history is empty or ends on an assistant turn
 * (providers reject those requests, and nothing is waiting) or when nothing it can see has
 * joined the wake since it last yielded, as when several wake-ups queue behind one run
 * that already handled them.
 * Under `implicitYield`, a turn whose calls were all successful sends and steers ends the run
 * as a yield would, without a model call to yield, when nothing arrived (see endsOnItsOwn).
 */
export async function runProcessLoop(deps: ProcessLoopDeps): Promise<void> {
  for (;;) {
    const assembled = await deps.assemble();
    syncWake(deps, assembled);
    const composedThrough = deps.wake.throughSeq;

    const last = deps.wake.view("process", false).at(-1);
    if (!last || last.role !== "user" || deps.wake.unchangedSinceYield(deps.lane)) {
      return;
    }
    deps.wake.setStatus(await deps.status());
    const request = laneRequest(deps, assembled);

    const response = await callLane(deps, request);

    let failed = false;
    const tracked = async (call: DwarToolUseBlock): Promise<ToolExecResult> => {
      const result = await deps.executeTool(call);
      failed ||= result.isError;
      return result;
    };
    const yielded = await runStep({ ...deps, executeTool: tracked }, response, () => false);
    if (yielded) {
      return;
    }
    if (!failed && endsOnItsOwn(deps, response.content, composedThrough)) {
      deps.wake.markYield(deps.lane);
      return;
    }
  }
}

/**
 * endsOnItsOwn is true when, under `implicitYield`, a turn ends the run without a model call
 * to yield: every call in it was send_message or steer_work (each succeeded, which the caller
 * checks) and nothing addressed to the agent arrived after the turn was composed through
 * `composedThrough`.
 */
function endsOnItsOwn(deps: ProcessLoopDeps, content: DwarResponseBlock[], composedThrough: number): boolean {
  const calls = content.filter((block): block is DwarToolUseBlock => block.type === "tool_use");
  if (!deps.implicitYield || calls.length === 0 || !calls.every((call) => call.name === SEND_MESSAGE || call.name === STEER_WORK)) {
    return false;
  }
  return !deps.transcript.transcriptFor(deps.agentId).some((row) => row.seq > composedThrough && row.toAgentId === deps.agentId);
}

/** textChars is the length of a turn's visible text, not counting its thinking. */
export function textChars(content: DwarResponseBlock[]): number {
  return content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
}
