/**
 * Agent runtime: lane locks, the steer queue, transcript, and lane runners.
 * Conversation enqueue always schedules a run — the lane lock serializes concurrent
 * wakes so a second user message is not dropped while conversation is busy.
 * Reasoning does not wake conversation on exit: it sends its own messages. A blanket
 * wake races a follow-up run whose transcript ends on an assistant turn, which chat
 * providers reject.
 */

import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { HathError } from "../errors.js";
import { failPendingHandoffs, pendingHandoffs } from "../db/handoffs.js";
import { writeAgentLog } from "../db/logs.js";
import { currentRequester } from "../db/messages.js";
import { agents } from "../db/schema.js";
import { BrowserDriver } from "../browser/driver.js";
import type { ChaaviClient } from "../chaavi/client.js";
import type { DwarClient } from "../dwar/client.js";
import type { GharClient } from "../ghar/client.js";
import type { NasClient } from "../nas/client.js";
import type { YaadClient } from "../yaad/client.js";
import type {
  DwarChatRequest,
  DwarChatResponse,
  DwarToolUseBlock,
  Lane,
  RoutedMessage,
} from "../types/domain.js";
import { arrivalsSince, assembleContext, assembleRouterContext, type TranscriptWindows } from "./context.js";
import { deliverAgentMessage } from "./deliver.js";
import { runConversationLoop } from "./conversation.js";
import { EventBus } from "./events.js";
import { DeviceGateway } from "./devices.js";
import { failedHandoffSteer } from "./handoffs.js";
import { LaneLocks } from "./locks.js";
import { runReasoningLoop } from "./reasoning.js";
import { SteerQueue } from "./steer.js";
import { HostSessions } from "./sessions.js";
import { ToolDebounce } from "./tool-debounce.js";
import { blockOpenJob, settleWakeJobs } from "./jobs.js";
import { executeTool, type ToolContext, type ToolExecResult } from "./tools.js";
import type { ToolCallerKind } from "../tools/shared.js";
import { TranscriptStore } from "./transcript.js";
import { Wake, WakeStore, type WakeLimits } from "./wake.js";
import { ROUTER_KEY } from "./router.js";
import { laneRequest, runStep, syncWake, type StepDeps } from "./step.js";
import { FORWARD_ATTACHMENT, SEND_MESSAGE } from "../types/domain.js";
import { createScheduler, type Scheduler } from "./scheduler.js";

export type RuntimeLog = {
  error: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type Runtime = {
  locks: LaneLocks;
  steer: SteerQueue;
  transcript: TranscriptStore;
  events: EventBus;
  devices: DeviceGateway;
  browsers: BrowserDriver;
  sessions: HostSessions;
  scheduler: Scheduler;
  /** Queue a lane run; returns the id of the wake it joins. */
  enqueueConversation: (agentId: string) => string;
  enqueueReasoning: (agentId: string) => string;
  /** The id of the agent's current wake, or null when it has none. */
  wakeOf: (agentId: string) => string | null;
  waitUntilIdle: () => Promise<void>;
  /** Run the router on one utterance from Ankur; resolves with every message it sent as him. */
  route: (content: string) => Promise<RoutedMessage[]>;
  toolContext: (
    callerId: string | null,
    lane: Lane,
    callerKind?: ToolCallerKind,
  ) => ToolContext;
};

/** Wire locks, queues, and lane runners for one process. */
export function createRuntime(opts: {
  db: Db;
  dwar: DwarClient;
  yaad: YaadClient;
  ghar: GharClient;
  chaavi: ChaaviClient;
  nas: NasClient;
  config: Config;
  log: RuntimeLog;
}): Runtime {
  const locks = new LaneLocks();
  const steer = new SteerQueue();
  /**
   * Per agent, the lane failure it last reported (request ids stripped), until one of its
   * runs next finishes cleanly: the same failure on every wake during an outage is reported
   * once, since each report wakes a requester that would fail the same way.
   */
  const reportedFailures = new Map<string, string>();
  const transcript = new TranscriptStore();
  const events = new EventBus(opts.log);
  const devices = new DeviceGateway(events, opts.config.devices.timeout_ms);
  const browsers = new BrowserDriver(opts.nas, opts.config, opts.log);
  const sessions = new HostSessions();
  const toolDebounce = new ToolDebounce({
    base_ms: opts.config.runtime.tool_debounce_base_ms,
    max_ms: opts.config.runtime.tool_debounce_max_ms,
  });
  const wakeLimits: WakeLimits = {
    toolResultsMaxChars: opts.config.runtime.wake_tool_results_max_chars,
    toolResultsKeptChars: opts.config.runtime.wake_tool_results_kept_chars,
    supersedeWindowTurns: opts.config.runtime.wake_supersede_window_turns,
    promptCeilingTokens: opts.config.runtime.prompt_ceiling_tokens,
    promptTrimTokens: opts.config.runtime.prompt_trim_tokens,
  };
  const wakes = new WakeStore(wakeLimits);
  /** Per agent, the newest transcript seq its last finished wake covered (see settleJobs). */
  const settledThrough = new Map<string, number>();
  let pending = 0;
  const idleWaiters: Array<() => void> = [];

  function track(work: Promise<void>): void {
    pending += 1;
    void work.finally(() => {
      pending -= 1;
      if (pending === 0) {
        const waiters = idleWaiters.splice(0);
        for (const waiter of waiters) {
          waiter();
        }
      }
    });
  }

  function waitUntilIdle(): Promise<void> {
    if (pending === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  /**
   * Always schedule a conversation run. The lane lock serializes concurrent wakes;
   * dropping here would lose a second user message that arrives while busy. Returns
   * the id of the wake the run joins: the agent's current one, or a new one.
   */
  function enqueueConversation(agentId: string): string {
    track(runLane(agentId, "conversation", wakes.hold(agentId)));
    return wakes.get(agentId).id;
  }

  function enqueueReasoning(agentId: string): string {
    track(runLane(agentId, "reasoning", wakes.hold(agentId)));
    return wakes.get(agentId).id;
  }

  function wakeOf(agentId: string): string | null {
    return wakes.idOf(agentId);
  }

  const scheduler = createScheduler({
    db: opts.db,
    transcript,
    events,
    enqueueConversation,
    enqueueReasoning,
    log: opts.log,
    tickSeconds: opts.config.schedule.tick_seconds,
  });

  const runtime: Runtime = {
    locks,
    steer,
    transcript,
    events,
    devices,
    browsers,
    sessions,
    scheduler,
    enqueueConversation,
    enqueueReasoning,
    wakeOf,
    waitUntilIdle,
    route,
    toolContext,
  };

  function toolContext(
    callerId: string | null,
    lane: Lane,
    callerKind: ToolCallerKind = callerId === null ? "router" : "agent",
  ): ToolContext {
    return {
      db: opts.db,
      callerId,
      callerKind,
      lane,
      yaad: opts.yaad,
      ghar: opts.ghar,
      chaavi: opts.chaavi,
      nas: opts.nas,
      dwar: opts.dwar,
      browsers,
      devices,
      steer,
      locks,
      transcript,
      events,
      sessions,
      toolDebounce,
      enqueueConversation,
      enqueueReasoning,
      wakeOf,
    };
  }

  /**
   * Acquire the lane lock and run reasoning or conversation. `releaseWake` is
   * this run's hold on the agent's shared wake, taken when the run was queued
   * and released last, after any follow-up run has taken its own hold. Only a
   * reasoning run that finished its loop queues a follow-up for steers that
   * arrived after its last drain; a run that failed, or found the agent missing
   * or retired, leaves them for the next wake instead of re-queuing itself forever.
   * The run that holds the wake last settles the jobs the wake left open
   * before releasing it (see settleJobs); a failure is logged, since the wake must still
   * release.
   * Runs wait for the lane lock without a deadline, so no queued wake is dropped. A retired
   * agent's conversation lane still runs while a hand-off waits, so a worker that retired
   * itself in the turn that handed off its result still gets that report sent.
   */
  async function runLane(agentId: string, lane: Lane, releaseWake: () => void): Promise<void> {
    let release: (() => void) | undefined;
    let reasoned = false;
    try {
      release = await locks.acquire(agentId, lane, null);
      events.emit({
        type: "lane_started",
        agent_id: agentId,
        lane,
        at: new Date().toISOString(),
      });
      try {
        const rows = await opts.db.select().from(agents).where(eq(agents.id, agentId));
        const agent = rows[0];
        const sendsLastReport = lane === "conversation" && (await pendingHandoffs(opts.db, agentId)).length > 0;
        if (!agent || (!agent.active && !sendsLastReport)) {
          return;
        }
        if (lane === "reasoning") {
          await runReasoningLoop(reasoningDeps(agentId));
          reasoned = true;
        } else {
          await runConversationLoop(conversationDeps(agentId));
        }
        reportedFailures.delete(agentId);
      } finally {
        events.emit({
          type: "lane_finished",
          agent_id: agentId,
          lane,
          at: new Date().toISOString(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.log.error({ err, agentId, lane }, `${lane} lane failed`);
      events.emit({
        type: "lane_failed",
        agent_id: agentId,
        lane,
        message,
        at: new Date().toISOString(),
      });
      if (lane === "conversation") {
        await failHandoffs(agentId, message).catch((handoffErr: unknown) => {
          opts.log.error({ err: handoffErr, agentId, code: "handoff_fail_failed" }, "recording failed hand-offs failed");
        });
      }
      const failure = message.replace(/req_[A-Za-z0-9]+/g, "req");
      if (reportedFailures.get(agentId) === failure) {
        opts.log.warn({ code: "lane_failure_repeat", agentId, lane }, `${lane} lane failed again with the error already reported`);
      } else {
        reportedFailures.set(agentId, failure);
        await reportLaneFailure(agentId, lane, message).catch((reportErr: unknown) => {
          opts.log.error({ err: reportErr, agentId, lane }, `${lane} failure report failed`);
        });
      }
    } finally {
      release?.();
      if (reasoned && steer.hasItems(agentId)) {
        enqueueReasoning(agentId);
      }
      if (wakes.lastHold(agentId)) {
        await settleJobs(agentId).catch((settleErr: unknown) => {
          opts.log.error({ err: settleErr, agentId, code: "job_settle_failed" }, "job settle failed");
        });
      }
      releaseWake();
    }
  }

  /**
   * failHandoffs records the hand-offs a failed conversation lane left unsent as failed,
   * and queues a steer telling the reasoning lane each was not sent. It does not wake that
   * lane: a conversation lane that keeps failing would otherwise be handed the same work again
   * and again, so the steer waits for the agent's next wake, and the failure is reported
   * to its requester like any other lane failure.
   */
  async function failHandoffs(agentId: string, message: string): Promise<void> {
    for (const handoff of await failPendingHandoffs(opts.db, agentId, message)) {
      steer.append(agentId, failedHandoffSteer(handoff, message));
    }
  }

  /**
   * settleJobs files away the jobs the ending wake touched but did nothing on (see
   * settleWakeJobs). A wake covers the agent's messages since its previous wake ended;
   * the first wake after boot covers everything since the transcript loaded.
   */
  async function settleJobs(agentId: string): Promise<void> {
    const since = settledThrough.get(agentId) ?? transcript.hydratedThrough;
    const lines = transcript.transcriptFor(agentId).filter((row) => row.seq > since);
    settledThrough.set(agentId, lines.at(-1)?.seq ?? since);
    await settleWakeJobs(opts.db, lines, agentId, wakes.get(agentId).reasoned());
  }

  /**
   * reportLaneFailure tells an agent that is waiting on the failed one that its work
   * stopped, as a notice that wakes it, so it does not wait on a dead worker; the notice
   * closes that agent's job with it as blocked. Ankur never gets one: hath's failures are
   * its own to log, never his to read, and his job stays open for the agent's next wake.
   * Tool errors never get here: they come back to the model as tool results.
   */
  async function reportLaneFailure(agentId: string, lane: Lane, message: string): Promise<void> {
    const requester = await currentRequester(opts.db, agentId);
    if (requester === null) {
      opts.log.error({ code: "lane_failed", agentId, lane, message }, "lane failed on Ankur's job; not messaging him");
      return;
    }
    const row = await deliverAgentMessage(
      { db: opts.db, transcript, events, enqueueConversation, enqueueReasoning, wakeOf },
      {
        fromAgentId: agentId,
        toAgentId: requester,
        content: `${agentId} stopped before finishing because of an error: ${message}. Work after its last update was not done; message ${agentId} to try again.`,
        notice: "lane_failed",
      },
    );
    await blockOpenJob(opts.db, requester, agentId, row.seq);
  }

  /** Tool execution and audit logging for a lane. Null agentId is the router. */
  function laneHelpers(agentId: string | null, lane: Lane) {
    const exec = (call: DwarToolUseBlock) => executeTool(toolContext(agentId, lane), call);
    const wakeId = () => (agentId === null ? null : wakes.idOf(agentId));
    const logResponse = (response: DwarChatResponse) =>
      writeAgentLog(opts.db, {
        agentId,
        lane,
        wakeId: wakeId(),
        event: "response",
        payload: {
          provider: response.provider,
          stop_reason: response.stop_reason,
          content: response.content,
          usage: response.usage,
        },
      });
    const logToolResult = (call: DwarToolUseBlock, result: ToolExecResult) =>
      writeAgentLog(opts.db, {
        agentId,
        lane,
        wakeId: wakeId(),
        event: "tool_result",
        payload: {
          tool_use_id: call.id,
          name: call.name,
          content: result.content,
          is_error: result.isError,
          ...result.audit,
        },
      });
    return { exec, logResponse, logToolResult };
  }

  function stepDeps(agentId: string, lane: keyof TranscriptWindows) {
    const helpers = laneHelpers(agentId, lane);
    return {
      agentId,
      lane,
      wake: wakes.get(agentId),
      assemble: () =>
        assembleContext({
          db: opts.db,
          agentId,
          lane,
          transcript,
          serviceRoot: opts.config.serviceRoot,
          windows: {
            conversation: {
              chars: opts.config.runtime.conversation_transcript_window_chars,
              stepChars: opts.config.runtime.transcript_window_step_chars,
              budgetTokens: wakeLimits.promptCeilingTokens - wakeLimits.promptTrimTokens,
            },
            reasoning: {
              chars: opts.config.runtime.reasoning_transcript_window_chars,
              stepChars: opts.config.runtime.transcript_window_step_chars,
              budgetTokens: wakeLimits.promptCeilingTokens - wakeLimits.promptTrimTokens,
            },
          },
        }),
      arrivalsSince: (afterSeq: number) => arrivalsSince(transcript, agentId, afterSeq),
      executeTool: helpers.exec,
      logResponse: helpers.logResponse,
      logToolResult: helpers.logToolResult,
    };
  }

  /**
   * The router's run. The router is ephemeral: each run sees only this
   * utterance — no earlier run, nothing sent as Ankur, no reply to him, and
   * nothing that arrives mid-run. The utterance is not stored as a message; an
   * audit row records it. Loops the router lane on Dwar's context-free
   * chat/complete until it yields. Runs are serialized. Nothing caps the loop.
   */
  async function route(content: string): Promise<RoutedMessage[]> {
    const release = await locks.acquire(ROUTER_KEY, "router", opts.config.runtime.lane_queue_timeout_ms);
    try {
      await writeAgentLog(opts.db, {
        agentId: null,
        lane: "router",
        event: "message",
        payload: {
          direction: "receive",
          from_agent_id: null,
          to_agent_id: null,
          content,
        },
      });

      const helpers = laneHelpers(null, "router");
      const sent: RoutedMessage[] = [];
      const deps: StepDeps = {
        agentId: ROUTER_KEY,
        lane: "router",
        wake: new Wake(wakeLimits),
        assemble: () =>
          assembleRouterContext({
            db: opts.db,
            serviceRoot: opts.config.serviceRoot,
            utterance: content,
          }),
        arrivalsSince: (afterSeq: number) => ({ turn: null, throughSeq: afterSeq }),
        call: (request: DwarChatRequest) => opts.dwar.complete(request, "hath/router"),
        executeTool: async (call: DwarToolUseBlock) => {
          const result = await helpers.exec(call);
          if ((call.name === SEND_MESSAGE || call.name === FORWARD_ATTACHMENT) && !result.isError) {
            sent.push(JSON.parse(result.content) as RoutedMessage);
          }
          return result;
        },
        logResponse: helpers.logResponse,
        logToolResult: helpers.logToolResult,
      };
      for (;;) {
        const assembled = await deps.assemble();
        syncWake(deps, assembled);
        const request = laneRequest(deps, assembled);
        const response = await deps.call(request);
        await deps.logResponse(response);
        if (await runStep(deps, response, () => false)) {
          return sent;
        }
      }
    } finally {
      release();
    }
  }

  function reasoningDeps(agentId: string) {
    return {
      ...stepDeps(agentId, "reasoning"),
      call: (request: DwarChatRequest) => opts.dwar.reason(request, `hath/${agentId}`),
      steer,
    };
  }

  function conversationDeps(agentId: string) {
    return {
      ...stepDeps(agentId, "conversation"),
      call: (request: DwarChatRequest) => opts.dwar.converse(request, `hath/${agentId}`),
      db: opts.db,
      transcript,
    };
  }

  return runtime;
}
