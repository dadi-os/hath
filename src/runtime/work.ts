import type { DwarChatRequest, DwarChatResponse, DwarResponseBlock, DwarToolUseBlock } from "../types/domain.js";
import { INGEST_MEMORY, QUEUE_MESSAGE } from "../types/domain.js";
import { editFile, writeFile } from "../tools/files/files.js";
import { scheduleMessage } from "../tools/hath/schedule-message.js";
import type { ToolExecResult } from "../tools/shared.js";
import { steerBrowser, steerTerminal } from "../tools/helper/tasks.js";
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
  /** `runtime.implicit_yield`: a turn of a queue_message and the saves that go with it ends the run (see endsOnItsOwn). */
  implicitYield: boolean;
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
 * A yield in a turn that wrote a message's worth of text and queued no message is answered
 * once with UNSENT_REPORT_TURN, since that text is a report nobody would otherwise get; a
 * yield that leaves the requester's latest message unanswered, with nothing pending to wake
 * the agent, is answered once with the reminder yieldReminder gives.
 * The wait tool ends the run like yield, after recording what it waits on; so does a turn of
 * only queue_message calls under `implicitYield` (see endsOnItsOwn).
 * This lane never messages anyone itself; everything it has to say goes to the process
 * lane with `queue_message`, which sends it.
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
  "[continue] Many turns have passed since you last sent your process lane a message. If you are reading a large file or log to answer one question, search it for just that and stop paging through it; if you already have an answer worth giving, call queue_message now; if you are partway through ordinary steps, carry on.";

/**
 * endsOnItsOwn is true when, under `implicitYield`, a turn ends the run without a model call to
 * yield or wait: it has a queue_message, no call in it failed, every call in it was a
 * queue_message or one of the saves that follow a result (SAVES), no queue_message was a progress
 * line (status running), and no browser or terminal task was started or steered in this wake
 * (its result may still need the lane's next step).
 * When any of those messages expects an agent's reply, the lane waits on those agents for
 * IMPLICIT_WAIT_MINUTES, as a wait call would; otherwise it yields. The run is marked yielded
 * either way, so the yield's reminders still apply.
 */
async function endsOnItsOwn(deps: WorkLoopDeps, outcomes: { call: DwarToolUseBlock; result: ToolExecResult }[]): Promise<boolean> {
  const messages = outcomes.filter(({ call }) => call.name === QUEUE_MESSAGE);
  if (
    !deps.implicitYield ||
    messages.length === 0 ||
    !outcomes.every(({ call, result }) => (call.name === QUEUE_MESSAGE || SAVES.has(call.name)) && !result.isError) ||
    messages.some(({ call }) => (call.input as { status?: string }).status === "running")
  ) {
    return false;
  }
  if (deps.wake.workCalls(Number.MAX_SAFE_INTEGER).some((call) => HELPER_STEERS.has(call.name) && call.failed === false)) {
    return false;
  }
  const awaited = messages.flatMap(({ result }) => {
    const queued = JSON.parse(result.content) as { to_agent_id: string | null; expects_reply: boolean };
    return queued.expects_reply && queued.to_agent_id !== null ? [queued.to_agent_id] : [];
  });
  if (awaited.length > 0) {
    await deps.wait([...new Set(awaited)], IMPLICIT_WAIT_MINUTES);
  }
  deps.wake.markYield(deps.lane);
  return true;
}

/** The tools a turn may call beside its queue_message and still end the run: they record what the message reports. */
const SAVES = new Set<string>([INGEST_MEMORY, writeFile.name, editFile.name, scheduleMessage.name]);

/** The tools that start or steer a helper task, whose result wakes the lane for its next step. */
const HELPER_STEERS = new Set([steerBrowser.name, steerTerminal.name]);

/** reports is true when a turn called message. */
function reports(content: DwarResponseBlock[]): boolean {
  return content.some((block) => block.type === "tool_use" && (block.name === QUEUE_MESSAGE));
}

/** A work-lane turn whose text is at least this long, queued nowhere, reads as a report left unsent. */
const UNSENT_REPORT_CHARS = 400;

/** The reminder a yield gets after a turn wrote a report as text and queued no message. */
export const UNSENT_REPORT_TURN =
  "[continue] Your last turn wrote a report as text and queued no message: text reaches no one. If it was meant for Ankur or any agent, queue it with queue_message now; otherwise yield again.";

/**
 * unsentReport is true when a turn wrote a message's worth of text but did not call
 * message, so whatever it reported went nowhere.
 */
function unsentReport(content: DwarResponseBlock[]): boolean {
  return textChars(content) >= UNSENT_REPORT_CHARS && !reports(content);
}
