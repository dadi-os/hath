import type { DwarResponseBlock } from "../types/domain.js";
import { MESSAGE } from "../types/domain.js";
import type { SteerQueue } from "./steer.js";
import { formatSteerTurn } from "./steer.js";
import { textChars } from "./process.js";
import { callLane, laneRequest, runStep, syncWake, type StepDeps } from "./step.js";

/** Step deps plus the steer queue the process lane writes to. */
export type WorkLoopDeps = StepDeps & {
  steer: SteerQueue;
  /** Runs once, before the run's first model call: the lane is awake, so whatever it waited on no longer holds. */
  woke: () => Promise<void>;
  /** The note a yield is answered with once, or null when the agent has left nothing unanswered (see yield-reminder.ts). */
  yieldReminder: () => Promise<string | null>;
};

/**
 * Work-lane loop over the agent's wake. Each call sees the model's own thinking, text and
 * tool calls, their full results, what the process lane sent, and mid-wake arrivals — never
 * the process lane's own turns — and the model is free to think
 * and write before or instead of calling a tool. A turn with no tool call
 * continues; the only clean exit is the embedded yield tool.
 *
 * A run that finds nothing new since the work lane last yielded in this wake ends
 * without a model call, as when a worker's report queues a run behind one that
 * already read it. Steers join the wake as the work lane-only turns where they happened. When
 * the process lane sets terminate, this wake stops in its tracks: no further tool
 * calls run (in-flight model output is logged, then its calls are refused).
 * A yield in a turn that wrote a message's worth of text and queued no message is answered
 * once with UNSENT_REPORT_TURN, since that text is a report nobody would otherwise get; a
 * yield that leaves the requester's latest message unanswered, with nothing pending to wake
 * the agent, is answered once with the reminder yieldReminder gives.
 * The wait tool ends the run like yield, after recording what it waits on.
 * This lane never messages anyone itself; everything it has to say goes to the process
 * lane with `message`, which sends it.
 */
export async function runWorkLoop(deps: WorkLoopDeps): Promise<void> {
  const stop = () => deps.steer.isTerminate(deps.agentId);
  const exit = () => {
    deps.steer.takeTerminate(deps.agentId);
  };

  let reminded = false;
  let remindedUnanswered = false;
  let woke = false;
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
        only: "work",
      });
    }
    if (stop() || deps.wake.unchangedSinceYield(deps.lane)) {
      exit();
      return;
    }

    if (!woke) {
      woke = true;
      await deps.woke();
    }
    const response = await callLane(deps, laneRequest(deps, assembled));
    turnsSinceReport = reports(response.content) ? 0 : turnsSinceReport + 1;

    if (await runStep(deps, response, stop)) {
      if (!stop() && !reminded && unsentReport(response.content)) {
        reminded = true;
        deps.wake.push({ message: { role: "user", content: UNSENT_REPORT_TURN }, only: "work" });
        continue;
      }
      if (!stop() && !remindedUnanswered) {
        const unanswered = await deps.yieldReminder();
        if (unanswered !== null) {
          remindedUnanswered = true;
          deps.wake.push({ message: { role: "user", content: unanswered }, only: "work" });
          continue;
        }
      }
      exit();
      return;
    }
    if (turnsSinceReport >= TURNS_BEFORE_NUDGE) {
      turnsSinceReport = 0;
      deps.wake.push({ message: { role: "user", content: LONG_SILENCE_TURN }, only: "work" });
    }
  }
}


export const TURNS_BEFORE_NUDGE = 60;

/**
 * The reminder after TURNS_BEFORE_NUDGE turns that reported nothing. It stops no work: hath never
 * decides from outside that an agent stalled. On 2026-10-24 networking-specialist spent two hours
 * grepping a 3,000-line tracker for one answer and never reported what it had.
 */
export const LONG_SILENCE_TURN =
  "[continue] Many turns have passed since you last sent your process lane a message. If you are reading a large file or log to answer one question, search it for just that and stop paging through it; if you already have an answer worth giving, call message now; if you are partway through ordinary steps, carry on.";

/** reports is true when a turn called message. */
function reports(content: DwarResponseBlock[]): boolean {
  return content.some((block) => block.type === "tool_use" && (block.name === MESSAGE));
}

/** A work-lane turn whose text is at least this long, queued nowhere, reads as a report left unsent. */
const UNSENT_REPORT_CHARS = 400;

/** The reminder a yield gets after a turn wrote a report as text and queued no message. */
export const UNSENT_REPORT_TURN =
  "[continue] Your last turn wrote a report as text and queued no message: text reaches no one. If it was meant for Ankur or any agent, queue it with message now; otherwise yield again.";

/**
 * unsentReport is true when a turn wrote a message's worth of text but did not call
 * message, so whatever it reported went nowhere.
 */
function unsentReport(content: DwarResponseBlock[]): boolean {
  return textChars(content) >= UNSENT_REPORT_CHARS && !reports(content);
}
