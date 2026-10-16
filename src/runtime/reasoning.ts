import type { DwarResponseBlock } from "../types/domain.js";
import { SEND_MESSAGE } from "../types/domain.js";
import type { SteerQueue } from "./steer.js";
import { formatSteerTurn } from "./steer.js";
import { callLane, laneRequest, runStep, syncWake, type StepDeps } from "./step.js";

/** Step deps plus the steer queue the conversation lane writes to. */
export type ReasoningLoopDeps = StepDeps & {
  steer: SteerQueue;
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
 * Resolves true when the turn that ended the run wrote text and handed nothing to
 * conversation: that text is a report nobody would otherwise send.
 */
export async function runReasoningLoop(deps: ReasoningLoopDeps): Promise<boolean> {
  const stop = () => deps.steer.isTerminate(deps.agentId);
  const exit = () => {
    deps.steer.takeTerminate(deps.agentId);
  };

  for (;;) {
    if (stop()) {
      exit();
      deps.steer.drain(deps.agentId);
      return false;
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
      return false;
    }

    const response = await callLane(deps, laneRequest(deps, assembled));

    if (await runStep(deps, response, stop)) {
      exit();
      return unsentReport(response.content);
    }
  }
}

/**
 * unsentReport is true when a turn wrote text but called no send_message, so whatever it
 * reported went nowhere.
 */
function unsentReport(content: DwarResponseBlock[]): boolean {
  const wrote = content.some((block) => block.type === "text" && block.text.trim().length > 0);
  return wrote && !content.some((block) => block.type === "tool_use" && block.name === SEND_MESSAGE);
}
