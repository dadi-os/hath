import type { DwarChatRequest, DwarChatResponse, DwarResponseBlock, DwarToolUseBlock } from "../types/domain.js";
import { INGEST_MEMORY, SEND_MESSAGE } from "../types/domain.js";
import { editFile, writeFile } from "../tools/files/files.js";
import { endRoutine } from "../tools/hath/end-routine.js";
import { remindMe } from "../tools/hath/remind-me.js";
import { setRoutine } from "../tools/hath/set-routine.js";
import type { ToolExecResult } from "../tools/shared.js";
import { steerBrowser, steerTerminal } from "../tools/helper/tasks.js";
import type { SteerQueue } from "./steer.js";
import { formatSteerTurn } from "./steer.js";
import { callLane, laneRequest, runStep, syncWake, type StepDeps } from "./step.js";

/** Step deps plus the steer queue the process lane writes to. */
export type WorkLoopDeps = StepDeps & {
  steer: SteerQueue;
  /** Runs once, before the run's first model call: the lane is awake, so whatever it waited on no longer holds. */
  woke: () => Promise<void>;
  /** The note a yield is answered with once, or null when the agent has left nothing unanswered (see yield-reminder.ts). */
  yieldReminder: () => Promise<string | null>;
  /** `runtime.implicit_yield`: a turn of a send_message and the saves that go with it ends the run (see endsOnItsOwn). */
  implicitYield: boolean;
  /** `runtime.implicit_steer_end`: a turn of only steers, messages and saves ends the run too (see endsOnItsOwn). */
  implicitSteerEnd: boolean;
  /** Records that the lane waits on `targets` for `minutes`, as the wait tool does (see watches.ts recordWatch). */
  wait: (targets: string[], minutes: number) => Promise<void>;
};

/** How long a run that ended on its own after asking agents waits on their replies before it is woken with facts. */
export const IMPLICIT_WAIT_MINUTES = 30;

/**
 * Work-lane loop over the agent's wake. Each call sees the model's own thinking, text and
 * tool calls, their full results, what the process lane sent, and mid-wake arrivals — never
 * the process lane's own turns — and the model is free to think
 * and write before or instead of calling a tool. A turn with no tool call
 * continues; the only clean exit is the yield tool.
 *
 * A run that finds nothing new since the work lane last yielded in this wake ends
 * without a model call, as when a worker's report queues a run behind one that
 * already read it. Steers join the wake as the work lane-only turns where they happened. When
 * the process lane sets terminate, this wake stops in its tracks: no further tool
 * calls run (the in-flight model call is aborted and its output discarded).
 * A turn of text and no tool call is the lane's answer (see send.ts replyWithText). A
 * yield that leaves the requester's latest message unanswered, with nothing pending to wake
 * the agent, is answered once with the reminder yieldReminder gives.
 * The wait tool ends the run like yield, after recording what it waits on; so does a turn of
 * only send_message calls under `implicitYield` (see endsOnItsOwn).
 */
export async function runWorkLoop(deps: WorkLoopDeps): Promise<void> {
  const stop = () => deps.steer.isTerminate(deps.agentId);
  const exit = () => {
    deps.steer.takeTerminate(deps.agentId);
  };

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
    const response = await callUnlessTerminated(deps, laneRequest(deps, assembled));
    if (response === null) {
      exit();
      deps.steer.drain(deps.agentId);
      return;
    }
    turnsSinceReport = reports(response.content) ? 0 : turnsSinceReport + 1;

    const outcomes: { call: DwarToolUseBlock; result: ToolExecResult }[] = [];
    const tracked = async (call: DwarToolUseBlock): Promise<ToolExecResult> => {
      const result = await deps.executeTool(call);
      outcomes.push({ call, result });
      return result;
    };
    if ((await runStep({ ...deps, executeTool: tracked }, response, stop)) || (!stop() && (await endsOnItsOwn(deps, outcomes)))) {
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

/**
 * callUnlessTerminated makes the work lane's model call and returns null as soon as the
 * process lane requests terminate, without waiting for the response. The abort signal is
 * passed to the call so the request is cancelled where the client supports it; an error
 * from a call abandoned this way is dropped because the wake it belonged to is over.
 */
async function callUnlessTerminated(
  deps: WorkLoopDeps,
  request: DwarChatRequest,
): Promise<DwarChatResponse | null> {
  const signal = deps.steer.signalFor(deps.agentId);
  if (signal.aborted) {
    return null;
  }
  const call = callLane(deps, request, signal);
  const terminated = new Promise<null>((resolve) => {
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
  call.catch(() => undefined);
  return await Promise.race([call, terminated]);
}

export const TURNS_BEFORE_NUDGE = 60;

/**
 * The reminder after TURNS_BEFORE_NUDGE turns that reported nothing. It stops no work: hath never
 * decides from outside that an agent stalled. On 2026-10-24 networking-specialist spent two hours
 * grepping a 3,000-line tracker for one answer and never reported what it had.
 */
export const LONG_SILENCE_TURN =
  "[continue] Many turns have passed since you last sent a message. If you are reading a large file or log to answer one question, search it for just that and stop paging through it; if you already have an answer worth giving, call send_message now; if you are partway through ordinary steps, carry on.";

/**
 * endsOnItsOwn is true when, under `implicitYield`, a turn ends the run without a model call to
 * yield or wait: it has a send_message, no call in it failed, every call in it was a
 * send_message or one of the saves that follow a result (SAVES), and no browser or terminal task was started or steered in this wake
 * (its result may still need the lane's next step).
 * Under `implicitSteerEnd` a turn also ends the run when it has a steer_browser, steer_terminal
 * or ingest_memory call beside send_message and saves, whatever the wake
 * steered before: each task it steered is waited on, as an awaited agent is, since its report
 * wakes the lane for the next step and a wait that times out wakes it with facts. A run that
 * ends before the requester has its answer is reminded once (see yieldReminder).
 * When any of the turn's messages is an ask to an agent, the lane waits on those agents for
 * IMPLICIT_WAIT_MINUTES, as a wait call would; otherwise it yields. The run is marked yielded
 * either way, so the yield's reminders still apply.
 */
async function endsOnItsOwn(deps: WorkLoopDeps, outcomes: { call: DwarToolUseBlock; result: ToolExecResult }[]): Promise<boolean> {
  const messages = outcomes.filter(({ call }) => call.name === SEND_MESSAGE);
  const steers = outcomes.filter(({ call }) => HELPER_STEERS.has(call.name));
  const ends = deps.implicitSteerEnd
    ? outcomes.some(({ call }) => call.name === SEND_MESSAGE || HELPER_STEERS.has(call.name) || call.name === INGEST_MEMORY)
    : messages.length > 0;
  const allowed = (name: string) => name === SEND_MESSAGE || SAVES.has(name) || (deps.implicitSteerEnd && HELPER_STEERS.has(name));
  if (
    !deps.implicitYield ||
    !ends ||
    !outcomes.every(({ call, result }) => allowed(call.name) && !result.isError)
  ) {
    return false;
  }
  if (!deps.implicitSteerEnd && deps.wake.workCalls(Number.MAX_SAFE_INTEGER).some((call) => HELPER_STEERS.has(call.name) && call.failed === false)) {
    return false;
  }
  const awaited = messages.flatMap(({ result }) => {
    const sent = JSON.parse(result.content) as { to_agent_id: string | null; ask: boolean };
    return sent.ask && sent.to_agent_id !== null ? [sent.to_agent_id] : [];
  });
  const tasks = steers.map(({ result }) => (JSON.parse(result.content) as { id: string }).id);
  const targets = [...new Set([...awaited, ...tasks])];
  if (targets.length > 0) {
    await deps.wait(targets, IMPLICIT_WAIT_MINUTES);
  }
  deps.wake.markYield(deps.lane);
  return true;
}

/** The tools a turn may call beside its send_message and still end the run: they record what the message reports. */
const SAVES = new Set<string>([INGEST_MEMORY, writeFile.name, editFile.name, setRoutine.name, endRoutine.name, remindMe.name]);

/** The tools that start or steer a helper task, whose result wakes the lane for its next step. */
const HELPER_STEERS = new Set([steerBrowser.name, steerTerminal.name]);

/** reports is true when a turn called message. */
function reports(content: DwarResponseBlock[]): boolean {
  return content.some((block) => block.type === "tool_use" && (block.name === SEND_MESSAGE));
}
