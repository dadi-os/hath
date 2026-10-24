import type { DwarResponseBlock } from "../types/domain.js";
import { HAND_OFF, SEND_MESSAGE } from "../types/domain.js";
import type { SteerQueue } from "./steer.js";
import { formatSteerTurn } from "./steer.js";
import { textChars } from "./conversation.js";
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
 * A yield in a turn that wrote a message's worth of text and handed off nothing is answered
 * once with UNSENT_REPORT_TURN, since that text is a report nobody would otherwise get.
 * This lane messages only the agents it brought in (send_message); everything it has to
 * say to anyone else goes to the conversation lane as a hand_off.
 */
export async function runReasoningLoop(deps: ReasoningLoopDeps): Promise<void> {
  const stop = () => deps.steer.isTerminate(deps.agentId);
  const exit = () => {
    deps.steer.takeTerminate(deps.agentId);
  };

  let reminded = false;
  let turnsSinceReport = 0;
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

    const response = await callLane(deps, laneRequest(deps, assembled));
    turnsSinceReport = reports(response.content) ? 0 : turnsSinceReport + 1;

    if (await runStep(deps, response, stop)) {
      if (!stop() && !reminded && unsentReport(response.content)) {
        reminded = true;
        deps.wake.push({ message: { role: "user", content: UNSENT_REPORT_TURN }, only: "reasoning" });
        continue;
      }
      exit();
      return;
    }
    if (turnsSinceReport >= TURNS_BEFORE_NUDGE) {
      turnsSinceReport = 0;
      deps.wake.push({ message: { role: "user", content: LONG_SILENCE_TURN }, only: "reasoning" });
    }
  }
}

/** How many model turns in a row may pass without a hand_off or send_message before the lane is asked what it has. */
export const TURNS_BEFORE_NUDGE = 60;

/**
 * The reminder after TURNS_BEFORE_NUDGE turns that reported nothing. It stops no work: hath never
 * decides from outside that an agent stalled. On 2026-10-24 networking-specialist spent two hours
 * grepping a 3,000-line tracker for one answer and never reported what it had.
 */
export const LONG_SILENCE_TURN =
  "[continue] Many turns have passed since you last handed off or sent anything. If you are reading a large file or log to answer one question, search it for just that and stop paging through it; if you already have an answer worth giving, hand it off now; if you are partway through ordinary steps, carry on.";

/** reports is true when a turn called hand_off or send_message. */
function reports(content: DwarResponseBlock[]): boolean {
  return content.some((block) => block.type === "tool_use" && (block.name === HAND_OFF || block.name === SEND_MESSAGE));
}

/** A reasoning turn whose text is at least this long, sent nowhere, reads as a report left unsent. */
const UNSENT_REPORT_CHARS = 400;

/** The reminder a yield gets after a turn wrote a report as text and handed off nothing. */
export const UNSENT_REPORT_TURN =
  "[continue] Your last turn wrote a report as text and handed off nothing: text reaches no one. If it was meant for Ankur or any agent but one you brought in, hand it off with hand_off now; otherwise yield again.";

/**
 * unsentReport is true when a turn wrote a message's worth of text but called neither
 * hand_off nor send_message, so whatever it reported went nowhere.
 */
function unsentReport(content: DwarResponseBlock[]): boolean {
  return textChars(content) >= UNSENT_REPORT_CHARS && !reports(content);
}
