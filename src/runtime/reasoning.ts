import { fail, type ToolExecResult } from "../tools/shared.js";
import type { DwarResponseBlock, DwarToolUseBlock } from "../types/domain.js";
import { SEND_MESSAGE } from "../types/domain.js";
import type { SteerQueue } from "./steer.js";
import { formatSteerTurn } from "./steer.js";
import { textChars } from "./conversation.js";
import { alreadySentRefusal, callLane, laneRequest, runStep, syncWake, type StepDeps } from "./step.js";
import type { TranscriptStore } from "./transcript.js";

/** Step deps plus the steer queue the conversation lane writes to, and the transcript the send gate reads. */
export type ReasoningLoopDeps = StepDeps & {
  steer: SteerQueue;
  transcript: TranscriptStore;
};

/**
 * Reasoning-lane loop over the agent's shared wake. Each call sees the whole
 * wake — the model's own thinking, text and tool calls, their full results,
 * conversation's steps, and mid-wake arrivals — and the model is free to think
 * and write before or instead of calling a tool. A turn with no tool call
 * continues; the only clean exit is the embedded yield tool.
 *
 * A run that finds nothing new since reasoning last yielded in this wake ends
 * without a model call, as when a worker's report queues a run behind one that
 * already read it. Steers join the wake as reasoning-only turns where they happened. When
 * conversation sets terminate, this wake stops in its tracks: no further tool
 * calls run (in-flight model output is logged, then its calls are refused).
 * A yield in a turn that wrote a message's worth of text and sent nothing is answered
 * once with UNSENT_REPORT_TURN, since that text is a report nobody would otherwise get.
 * A send_message to someone this agent messaged after the step was composed (the
 * conversation lane, meanwhile) is refused with what went out (see alreadySentRefusal).
 */
export async function runReasoningLoop(deps: ReasoningLoopDeps): Promise<void> {
  const stop = () => deps.steer.isTerminate(deps.agentId);
  const exit = () => {
    deps.steer.takeTerminate(deps.agentId);
  };

  let reminded = false;
  for (;;) {
    if (stop()) {
      exit();
      deps.steer.drain(deps.agentId);
      return;
    }

    const assembled = await deps.assemble();
    syncWake(deps, assembled);
    const steers = deps.steer.drain(deps.agentId);
    if (steers.length > 0) {
      deps.wake.push({
        message: { role: "user", content: formatSteerTurn(steers) },
        only: "reasoning",
      });
    }
    if (stop() || deps.wake.unchangedSinceYield(deps.lane)) {
      exit();
      return;
    }

    const composedThrough = deps.wake.throughSeq;
    const response = await callLane(deps, laneRequest(deps, assembled));
    const gated = async (call: DwarToolUseBlock): Promise<ToolExecResult> => {
      const to = (call.input as { to_agent_id?: string | null }).to_agent_id;
      if (call.name === SEND_MESSAGE && to !== undefined) {
        const refusal = alreadySentRefusal(deps.transcript, deps.agentId, to, composedThrough);
        if (refusal !== null) {
          return fail(refusal);
        }
      }
      return deps.executeTool(call);
    };

    if (await runStep({ ...deps, executeTool: gated }, response, stop)) {
      if (!stop() && !reminded && unsentReport(response.content)) {
        reminded = true;
        deps.wake.push({ message: { role: "user", content: UNSENT_REPORT_TURN }, only: "reasoning" });
        continue;
      }
      exit();
      return;
    }
  }
}

/** A reasoning turn whose text is at least this long, sent nowhere, reads as a report left unsent. */
const UNSENT_REPORT_CHARS = 400;

/** The reminder a yield gets after a turn wrote a report as text and sent nothing. */
export const UNSENT_REPORT_TURN =
  "[continue] Your last turn wrote a report as text and sent nothing: text reaches no one. If it was meant for someone, send it with send_message now; otherwise yield again.";

/**
 * unsentReport is true when a turn wrote a message's worth of text but called no
 * send_message, so whatever it reported went nowhere.
 */
function unsentReport(content: DwarResponseBlock[]): boolean {
  return (
    textChars(content) >= UNSENT_REPORT_CHARS &&
    !content.some((block) => block.type === "tool_use" && block.name === SEND_MESSAGE)
  );
}
