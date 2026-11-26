/**
 * Agent runtime: run locks, interrupts, the thread, and the agent's loop. Enqueueing always
 * schedules a run — the run lock serializes concurrent wakes so a second message is not dropped
 * while the agent is busy. A run that finds nothing new since the agent last yielded ends without
 * a model call, because a follow-up run whose history ends on an assistant turn is rejected by
 * chat providers.
 */

import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { writeAgentLog } from "../db/logs.js";
import { currentRequester, insertUtterance } from "../db/messages.js";
import { endWake, insertWake, MANUAL_ORIGIN } from "../db/wakes.js";
import { agents } from "../db/schema.js";
import type { DwarClient } from "../dwar/client.js";
import type { GharClient } from "../ghar/client.js";
import type { NasClient } from "../nas/client.js";
import type { YaadClient } from "../yaad/client.js";
import type {
  DwarChatRequest,
  DwarChatResponse,
  DwarToolUseBlock,
  RoutedMessage,
} from "../types/domain.js";
import { arrivalsSince, assembleContext, assembleRouterContext } from "./context.js";
import { deliverAgentMessage, type DeliverDeps } from "./deliver.js";
import { renderHeader } from "./header.js";
import { replyWithText } from "./send.js";
import { EventBus } from "./events.js";
import { DeviceGateway } from "./devices.js";
import { RunLocks } from "./locks.js";
import { runAgentLoop } from "./loop.js";
import { Interrupts } from "./interrupts.js";
import { stopAgent, type StopResult } from "./stop.js";
import { HostSessions } from "./sessions.js";
import { HelperReports } from "./helper-reports.js";
import type { FileStore } from "./files.js";
import { clearWatch, recordPendingWatch, watchOf } from "./watches.js";
import { yieldReminder } from "./yield-reminder.js";
import { ToolDebounce } from "./tool-debounce.js";
import { blockOpenJob, settleWakeJobs } from "./jobs.js";
import { executeTool, type ToolContext, type ToolExecResult } from "./tools.js";
import type { ToolCallerKind } from "../tools/shared.js";
import { TranscriptStore } from "./transcript.js";
import { PROSE_CHARS_PER_TOKEN, Wake, WakeStore, type WakeLimits } from "./wake.js";
import { ROUTER_KEY } from "./router.js";
import { callModel, runStep, stepRequest, syncWake, type StepDeps } from "./step.js";
import { SEND_MESSAGE, type WakeOrigin } from "../types/domain.js";
import { sweepCaches } from "./retention.js";
import { createScheduler, type Scheduler } from "./scheduler.js";
import { sendPickups } from "./pickups.js";
import { WakeActivity } from "./wake-activity.js";

export type RuntimeLog = {
  error: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type Runtime = {
  locks: RunLocks;
  interrupts: Interrupts;
  transcript: TranscriptStore;
  events: EventBus;
  devices: DeviceGateway;
  sessions: HostSessions;
  files: FileStore;
  /** Follows Nas's event stream and delivers helper reports to their agents. */
  helperReports: HelperReports;
  scheduler: Scheduler;
  /** What delivering a message needs, for the routes that deliver as Ankur. */
  deliver: DeliverDeps;
  /**
   * Queue a run; returns the id of the wake it joins. `reason` is why, for the wake's
   * first line; `origin` is why, as the wake's row records it when the run creates the wake
   * (manual when left out), and is ignored when the run joins a wake already running.
   */
  enqueue: (agentId: string, reason?: string, origin?: WakeOrigin) => string;
  /** Coalesced `wake_activity` events (see wake-activity.ts). */
  wakeActivity: WakeActivity;
  /** The id of the agent's current wake, or null when it has none. */
  wakeOf: (agentId: string) => string | null;
  /** The job the agent's current wake is on, or null when it has no wake or none is on a job. */
  wakeJobOf: (agentId: string) => string | null;
  /** Ends the agent's running loop, halts its job's helper tasks and marks the job stopped by `by` (see stop.ts). */
  stop: (agentId: string, by: string) => Promise<StopResult>;
  waitUntilIdle: () => Promise<void>;
  /** Run the router on one utterance from Ankur; resolves with every message it sent as him. */
  route: (content: string) => Promise<RoutedMessage[]>;
  toolContext: (callerId: string | null, callerKind?: ToolCallerKind) => ToolContext;
};

/** Wire locks, interrupts and the agent loop for one process. */
export function createRuntime(opts: {
  db: Db;
  dwar: DwarClient;
  yaad: YaadClient;
  ghar: GharClient;
  nas: NasClient;
  config: Config;
  log: RuntimeLog;
}): Runtime {
  const locks = new RunLocks();
  const interrupts = new Interrupts();
  /**
   * Per agent, the run failure it last reported (request ids stripped), until one of its
   * runs next finishes cleanly: the same failure on every wake during an outage is reported
   * once, since each report wakes a requester that would fail the same way.
   */
  const reportedFailures = new Map<string, string>();
  const transcript = new TranscriptStore();
  const events = new EventBus(opts.log);
  const devices = new DeviceGateway(events, opts.config.devices.timeout_ms);
  const sessions = new HostSessions(opts.nas);
  const files: FileStore = { nas: opts.nas, dir: opts.config.files.dir };
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
    filesDir: opts.config.files.dir,
  };
  const wakes = new WakeStore(wakeLimits);
  const wakeActivity = new WakeActivity(opts.db, events, opts.log);
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
   * enqueue queues a run on the agent's wake, creating the wake when it has none. The wake
   * belongs to the job its first reason belongs to (`origin.jobId`); a wake that began with no
   * job takes the first one a later arrival brings. The run lock serializes runs; dropping one
   * here would lose a second message that arrives while the agent is busy. Returns the id of
   * the wake the run joins: the agent's current one, or a new one.
   */
  function enqueue(agentId: string, reason?: string, origin?: WakeOrigin): string {
    const created = wakes.peek(agentId) === undefined;
    const release = wakes.hold(agentId);
    const wake = wakes.get(agentId);
    wake.noteReason(reason);
    if (created) {
      beginWake(agentId, wake, origin ?? MANUAL_ORIGIN);
    }
    if (wake.jobId === null && origin?.jobId !== undefined) {
      wake.jobId = origin.jobId;
      wake.jobIsNew = origin.jobIsNew === true;
    }
    track(runAgent(agentId, release));
    return wake.id;
  }

  /**
   * preempt cancels the model call `agentId`'s running loop has out when its wake is on job
   * `jobId`: an arrival that changes the job is read before the call's answer is acted on.
   */
  function preempt(agentId: string, jobId: string): void {
    if (wakes.peek(agentId)?.jobId === jobId) {
      interrupts.preempt(agentId);
    }
  }

  /** isLive is true when the agent's loop is running, or it waits on something pending. */
  async function isLive(agentId: string): Promise<boolean> {
    if (locks.isBusy(agentId)) {
      return true;
    }
    const watch = await watchOf(opts.db, agentId);
    return watch !== undefined && watch.targets.length > 0;
  }

  /**
   * beginWake writes the new wake's row and announces it once written, so a client that
   * refetches on `wake_started` finds it. A failed write is logged; the wake still runs.
   */
  function beginWake(agentId: string, wake: Wake, origin: WakeOrigin): void {
    wake.recorded = insertWake(opts.db, { id: wake.id, agentId, origin })
      .then(() => {
        events.emit({
          type: "wake_started",
          agent_id: agentId,
          wake_id: wake.id,
          reason: { kind: origin.kind, ref: origin.ref },
          at: new Date().toISOString(),
        });
      })
      .catch((err: unknown) => {
        opts.log.error({ err, agentId, wakeId: wake.id, code: "wake_insert_failed" }, "recording the wake failed");
      });
    track(wake.recorded);
  }

  /**
   * finishWake closes the wake's row and announces its outcome: failed when a run died,
   * waiting when the agent watches a task or agent, else yielded.
   */
  async function finishWake(agentId: string, wake: Wake): Promise<void> {
    await wake.recorded;
    wakeActivity.stop(wake.id);
    await endWake(opts.db, wake.id, new Date(), wake.error);
    const outcome = wake.error !== null ? "failed" : (await watchOf(opts.db, agentId)) !== undefined ? "waiting" : "yielded";
    events.emit({ type: "wake_ended", agent_id: agentId, wake_id: wake.id, outcome, at: new Date().toISOString() });
  }

  /** background keeps `work` in the idle count and logs a failure, since nothing awaits it. */
  function background(work: Promise<void>): void {
    track(
      work.catch((err: unknown) => {
        opts.log.error({ err, code: "background_failed" }, "background work failed");
      }),
    );
  }

  function wakeOf(agentId: string): string | null {
    return wakes.idOf(agentId);
  }

  function wakeJobOf(agentId: string): string | null {
    return wakes.peek(agentId)?.jobId ?? null;
  }

  function stop(agentId: string, by: string): Promise<StopResult> {
    return stopAgent({ db: opts.db, nas: opts.nas, interrupts, wakeJobId: wakeJobOf }, agentId, by);
  }

  const deliverDeps: DeliverDeps = { db: opts.db, transcript, events, enqueue, preempt, wakeActivity, answerByMinutes: opts.config.runtime.answer_by_minutes };
  const scheduler = createScheduler({
    db: opts.db,
    transcript,
    events,
    enqueue,
    preempt,
    wakeActivity,
    answerByMinutes: opts.config.runtime.answer_by_minutes,
    log: opts.log,
    tickSeconds: opts.config.schedule.tick_seconds,
    watches: { deliver: deliverDeps, nas: opts.nas },
    sweep: async (now) => {
      const swept = await sweepCaches(files, opts.config.files.cache_retention_days, now);
      opts.log.info({ code: "cache_swept", files: swept }, "cache sweep done");
    },
    pickups: async (now) => {
      const sent = await sendPickups(deliverDeps, now, opts.config.runtime.pickup_delay_s * 1000, isLive);
      if (sent > 0) {
        opts.log.info({ code: "pickups_sent", count: sent }, "hath sent pickups for overdue jobs");
      }
    },
  });

  const helperReports = new HelperReports({
    nas: opts.nas,
    deliver: deliverDeps,
    log: opts.log,
  });

  const runtime: Runtime = {
    locks,
    interrupts,
    transcript,
    events,
    devices,
    sessions,
    files,
    helperReports,
    scheduler,
    deliver: deliverDeps,
    enqueue,
    wakeActivity,
    wakeOf,
    wakeJobOf,
    stop,
    waitUntilIdle,
    route,
    toolContext,
  };

  function toolContext(callerId: string | null, callerKind: ToolCallerKind = callerId === null ? "router" : "agent"): ToolContext {
    return {
      db: opts.db,
      callerId,
      callerKind,
      yaad: opts.yaad,
      ghar: opts.ghar,
      nas: opts.nas,
      dwar: opts.dwar,
      devices,
      locks,
      transcript,
      events,
      sessions,
      files,
      callId: null,
      background,
      toolDebounce,
      enqueue,
      preempt,
      wakeActivity,
      wakeId: callerId === null ? null : wakes.idOf(callerId),
      jobId: callerId === null ? null : (wakes.peek(callerId)?.jobId ?? null),
      answerByMinutes: opts.config.runtime.answer_by_minutes,
      promptCeilingTokens: opts.config.runtime.prompt_ceiling_tokens,
      activityCeilingShare: opts.config.runtime.activity_ceiling_share,
    };
  }

  /**
   * Acquire the run lock and run the agent's loop. `releaseWake` is this run's hold on the
   * agent's wake, taken when the run was queued and released last. The run that holds the wake
   * last settles the jobs the wake left open before releasing it (see settleJobs); a failure is
   * logged, since the wake must still release. A run that failed, or found the agent missing or
   * retired, is reported and not retried. Runs wait for the lock without a deadline, so no
   * queued wake is dropped.
   */
  async function runAgent(agentId: string, releaseWake: () => void): Promise<void> {
    let release: (() => void) | undefined;
    try {
      release = await locks.acquire(agentId, null);
      events.emit({ type: "run_started", agent_id: agentId, at: new Date().toISOString() });
      try {
        const rows = await opts.db.select().from(agents).where(eq(agents.id, agentId));
        const agent = rows[0];
        if (!agent || !agent.active) {
          return;
        }
        await runAgentLoop(loopDeps(agentId));
        reportedFailures.delete(agentId);
      } finally {
        events.emit({ type: "run_finished", agent_id: agentId, at: new Date().toISOString() });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.log.error({ err, agentId }, "run failed");
      events.emit({ type: "run_failed", agent_id: agentId, message, at: new Date().toISOString() });
      wakes.peek(agentId)?.noteError(`run failed: ${message}`);
      const failure = message.replace(/req_[A-Za-z0-9]+/g, "req");
      if (reportedFailures.get(agentId) === failure) {
        opts.log.warn({ code: "run_failure_repeat", agentId }, "run failed again with the error already reported");
      } else {
        reportedFailures.set(agentId, failure);
        await reportRunFailure(agentId, message).catch((reportErr: unknown) => {
          opts.log.error({ err: reportErr, agentId }, "failure report failed");
        });
      }
    } finally {
      release?.();
      if (wakes.lastHold(agentId)) {
        await settleJobs(agentId).catch((settleErr: unknown) => {
          opts.log.error({ err: settleErr, agentId, code: "job_settle_failed" }, "job settle failed");
        });
        await finishWake(agentId, wakes.get(agentId)).catch((endErr: unknown) => {
          opts.log.error({ err: endErr, agentId, code: "wake_end_failed" }, "closing the wake failed");
        });
      }
      releaseWake();
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
    await settleWakeJobs(opts.db, opts.nas, lines, agentId, wakes.get(agentId));
  }

  /**
   * reportRunFailure tells an agent that is waiting on the failed one that its work
   * stopped, as a notice that wakes it, so it does not wait on a dead worker; the notice
   * closes that agent's job with it as blocked. Ankur never gets one: hath's failures are
   * its own to log, never his to read, and his job stays open for the agent's next wake.
   * Tool errors never get here: they come back to the model as tool results.
   */
  async function reportRunFailure(agentId: string, message: string): Promise<void> {
    const requester = await currentRequester(opts.db, agentId);
    if (requester === null) {
      opts.log.error({ code: "run_failed", agentId, message }, "run failed on Ankur's job; not messaging him");
      return;
    }
    const row = await deliverAgentMessage(
      deliverDeps,
      {
        fromAgentId: agentId,
        toAgentId: requester,
        content: `${agentId} stopped before finishing because of an error: ${message}. Work after its last update was not done; message ${agentId} to try again.`,
        notice: "run_failed",
      },
    );
    await blockOpenJob(opts.db, requester, agentId, row.seq);
  }

  /** Tool execution and audit logging for a run. Null agentId is the router. */
  function runHelpers(agentId: string | null) {
    const exec = (call: DwarToolUseBlock) => executeTool(toolContext(agentId), call);
    const wakeId = () => (agentId === null ? null : wakes.idOf(agentId));
    const jobId = () => (agentId === null ? null : (wakes.peek(agentId)?.jobId ?? null));
    const logResponse = (response: DwarChatResponse) =>
      writeAgentLog(opts.db, {
        agentId,
        wakeId: wakeId(),
        jobId: jobId(),
        event: "response",
        payload: {
          provider: response.provider,
          stop_reason: response.stop_reason,
          content: response.content,
          usage: response.usage,
        },
      });
    const logAborted = () =>
      writeAgentLog(opts.db, {
        agentId,
        wakeId: wakeId(),
        jobId: jobId(),
        event: "response",
        payload: {
          stop_reason: "aborted",
          aborted: true,
          content: [],
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });
    const logToolResult = (call: DwarToolUseBlock, result: ToolExecResult) =>
      writeAgentLog(opts.db, {
        agentId,
        wakeId: wakeId(),
        jobId: jobId(),
        event: "tool_result",
        payload: {
          tool_use_id: call.id,
          name: call.name,
          content: result.content,
          is_error: result.isError,
          ...result.audit,
        },
      });
    return { exec, logResponse, logAborted, logToolResult };
  }

  /** The agent's step deps: its context, its folds of arrivals, its tools and its log. */
  function agentStepDeps(agentId: string) {
    const helpers = runHelpers(agentId);
    const { runtime: limits } = opts.config;
    return {
      agentId,
      wake: wakes.get(agentId),
      toolChoice: "auto" as const,
      tagTurns: true,
      assemble: async () => {
        const wake = wakes.get(agentId);
        const assembled = await assembleContext({
          db: opts.db,
          agentId,
          transcript,
          serviceRoot: opts.config.serviceRoot,
          window: {
            chars: Math.floor(limits.prompt_ceiling_tokens * limits.thread_window_share * PROSE_CHARS_PER_TOKEN),
            stepChars: limits.thread_window_step_chars,
            budgetTokens: wakeLimits.promptCeilingTokens - wakeLimits.promptTrimTokens,
          },
          continuation: wake.started || wake.jobId === null || wake.jobIsNew ? null : { wakeId: wake.id, jobId: wake.jobId, filesDir: opts.config.files.dir },
        });
        if (wake.started) {
          return assembled;
        }
        const header = await renderHeader({
          db: opts.db,
          agentId,
          reasons: wake.reasonList,
          jobId: wake.jobId,
          jobIsNew: wake.jobIsNew,
          now: new Date(),
          activityHours: limits.activity_hours,
          activityShare: limits.activity_ceiling_share,
          ceilingTokens: limits.prompt_ceiling_tokens,
        });
        return { ...assembled, header };
      },
      arrivalsSince: (afterSeq: number) => arrivalsSince(transcript, agentId, afterSeq),
      executeTool: helpers.exec,
      logResponse: helpers.logResponse,
      logToolResult: helpers.logToolResult,
    };
  }

  /**
   * The router's run. The router is ephemeral: each run sees only this
   * utterance — no earlier run, nothing sent as Ankur, no reply to him, and
   * nothing that arrives mid-run. The utterance is stored as a `utterance` message,
   * which belongs to no conversation. Loops the model on Dwar's context-free
   * chat/complete until it yields. Runs are serialized. Nothing caps the loop.
   */
  async function route(content: string): Promise<RoutedMessage[]> {
    const release = await locks.acquire(ROUTER_KEY, opts.config.runtime.router_queue_timeout_ms);
    try {
      await insertUtterance(opts.db, content);

      const helpers = runHelpers(null);
      const sent: RoutedMessage[] = [];
      const deps: StepDeps = {
        agentId: ROUTER_KEY,
        wake: new Wake(wakeLimits),
        toolChoice: "any",
        tagTurns: false,
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
          if (call.name === SEND_MESSAGE && !result.isError) {
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
        const response = await callModel(deps, stepRequest(deps, assembled));
        if (response === null) {
          throw new Error("the router's model call was cancelled, and nothing cancels it");
        }
        if (await runStep(deps, response, () => false)) {
          return sent;
        }
      }
    } finally {
      release();
    }
  }

  function loopDeps(agentId: string) {
    const helpers = runHelpers(agentId);
    return {
      ...agentStepDeps(agentId),
      call: (request: DwarChatRequest, signal?: AbortSignal) => opts.dwar.agent(request, `hath/${agentId}`, signal),
      interrupts,
      woke: () => clearWatch(opts.db, agentId),
      replyWithText: (text: string) => replyWithText(toolContext(agentId), text),
      yieldReminder: () => yieldReminder({ db: opts.db, nas: opts.nas }, agentId, wakes.peek(agentId)?.jobId ?? null),
      watchPending: (minutes: number) => recordPendingWatch(opts.db, opts.nas, agentId, wakes.peek(agentId)?.jobId ?? null, minutes),
      logAborted: helpers.logAborted,
    };
  }

  return runtime;
}
