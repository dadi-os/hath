/**
 * The agent's loop: one run over the agent's wake. Each step folds in what arrived since the
 * last one, makes one model call and runs the tools it asked for.
 */

import type { DwarChatRequest, DwarChatResponse, DwarToolUseBlock } from "../types/domain.js";
import { INGEST_MEMORY, SEND_MESSAGE } from "../types/domain.js";
import { editFile, writeFile } from "../tools/files/files.js";
import { endRoutine } from "../tools/hath/end-routine.js";
import { remindMe } from "../tools/hath/remind-me.js";
import { setRoutine } from "../tools/hath/set-routine.js";
import type { ToolExecResult } from "../tools/shared.js";
import { steerBrowser, steerTerminal, stopTask } from "../tools/helper/tasks.js";
import type { Interrupts } from "./interrupts.js";
import { callModel, runStep, stepRequest, syncWake, type StepDeps } from "./step.js";

/** What the loop needs beside the step deps. */
export type AgentLoopDeps = StepDeps & {
  interrupts: Interrupts;
  /** Runs once, before the run's first model call: the agent is awake, so whatever it waited on no longer holds. */
  woke: () => Promise<void>;
  /** The note a yield is answered with once, or null when the job needs none (see yield-reminder.ts). */
  yieldReminder: () => Promise<string | null>;
  /** Records that the agent waits on its job's pending items for `minutes`, when it has any (see watches.ts recordPendingWatch). */
  watchPending: (minutes: number) => Promise<void>;
  /** Writes the log row of a model call that was cancelled before it answered. */
  logAborted: () => Promise<void>;
};

/** How long a run that ended on its own, with asks or helpers pending, waits before it is woken with facts. */
export const IMPLICIT_WAIT_MINUTES = 30;

/**
 * runAgentLoop runs the agent over its wake until it yields. Messages that arrive between
 * steps join the next one; one from the requester of the wake's job also cancels the model
 * call in flight, and the step runs again with it in view. A stop ends the run: no further tool
 * call runs and the model call in flight is cancelled. A run that finds nothing new since the
 * agent last yielded in this wake ends without a model call, as when a helper's report queues a
 * run behind one that already read it. A turn of text and no tool call is the agent's answer
 * (see send.ts replyWithText). A run that ends with asks or helpers pending records what it
 * waits on first, so their answer wakes it, or the facts do after IMPLICIT_WAIT_MINUTES. A yield
 * that leaves the job unanswered, with nothing pending to wake the agent, is answered once with
 * the reminder yieldReminder gives. A turn of only sends and steers, with any saves, ends the
 * run like a yield (see endsOnItsOwn).
 */
export async function runAgentLoop(deps: AgentLoopDeps): Promise<void> {
  const stopped = () => deps.interrupts.isStopped(deps.agentId);
  deps.interrupts.enter(deps.agentId);
  try {
    let reminded = false;
    let woke = false;
    for (;;) {
      if (stopped()) {
        return;
      }
      const signal = deps.interrupts.begin(deps.agentId);
      const assembled = await deps.assemble();
      syncWake(deps, assembled);
      if (stopped() || deps.wake.unchangedSinceYield()) {
        return;
      }
      if (!woke) {
        woke = true;
        await deps.woke();
      }
      const response = await callUnlessPreempted(deps, stepRequest(deps, assembled), signal);
      if (response === null) {
        continue;
      }

      const outcomes: { call: DwarToolUseBlock; result: ToolExecResult }[] = [];
      const tracked = async (call: DwarToolUseBlock): Promise<ToolExecResult> => {
        const result = await deps.executeTool(call);
        outcomes.push({ call, result });
        return result;
      };
      if ((await runStep({ ...deps, executeTool: tracked }, response, stopped)) || (!stopped() && (await endsOnItsOwn(deps, outcomes)))) {
        if (!stopped()) {
          await deps.watchPending(IMPLICIT_WAIT_MINUTES);
        }
        if (!stopped() && !reminded) {
          const unanswered = await deps.yieldReminder();
          if (unanswered !== null) {
            reminded = true;
            deps.wake.push({ message: { role: "user", content: unanswered } });
            continue;
          }
        }
        return;
      }
    }
  } finally {
    deps.interrupts.leave(deps.agentId);
  }
}

/**
 * callUnlessPreempted makes the model call and returns null as soon as the signal aborts, without
 * waiting for the response: the request is cancelled where the client supports it, and a response
 * that arrives anyway is dropped. A call cancelled in flight is logged as aborted.
 */
async function callUnlessPreempted(
  deps: AgentLoopDeps,
  request: DwarChatRequest,
  signal: AbortSignal,
): Promise<DwarChatResponse | null> {
  if (signal.aborted) {
    return null;
  }
  const call = callModel(deps, request, signal);
  const aborted = new Promise<null>((resolve) => {
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
  call.catch(() => undefined);
  const response = await Promise.race([call, aborted]);
  if (response === null) {
    await deps.logAborted();
  }
  return response;
}

/**
 * endsOnItsOwn is true when a turn ends the run without a model call to yield: it has a
 * send_message or a steer, no call in it failed, and every call in it was one of those or a save
 * that records what the message reports (SAVES). A store alone does not end the run: the agent
 * reads what it stored before it replies. The run is marked yielded, so the yield reminder still applies.
 */
async function endsOnItsOwn(deps: AgentLoopDeps, outcomes: { call: DwarToolUseBlock; result: ToolExecResult }[]): Promise<boolean> {
  const ends = outcomes.some(({ call }) => call.name === SEND_MESSAGE || HELPER_STEERS.has(call.name));
  const allowed = (name: string) => name === SEND_MESSAGE || SAVES.has(name) || HELPER_STEERS.has(name);
  if (!ends || !outcomes.every(({ call, result }) => allowed(call.name) && !result.isError)) {
    return false;
  }
  deps.wake.markYield();
  return true;
}

/** The tools a turn may call beside its send_message and still end the run: they record what the message reports. */
const SAVES = new Set<string>([INGEST_MEMORY, writeFile.name, editFile.name, setRoutine.name, endRoutine.name, remindMe.name, stopTask.name]);

/** The tools that start or steer a helper task, whose result wakes the agent for its next step. */
const HELPER_STEERS = new Set([steerBrowser.name, steerTerminal.name]);
