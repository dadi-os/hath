/**
 * Agent runtime: lane locks, the steer queue, transcript, and lane runners.
 * Process-lane enqueue always schedules a run — the lane lock serializes concurrent
 * wakes so a second user message is not dropped while the process lane is busy.
 * The work lane wakes the process lane when it queues a message (`queue_message`), not on exit.
 * A blanket wake races a follow-up run whose transcript ends on an assistant turn, which
 * chat providers reject.
 */

import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { failPendingOutbox, pendingOutbox } from "../db/outbox.js";
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
  Lane,
  RoutedMessage,
} from "../types/domain.js";
import { carriedWork } from "./carry.js";
import { arrivalsSince, assembleContext, assembleRouterContext, type TranscriptWindows } from "./context.js";
import { deliverAgentMessage } from "./deliver.js";
import { runProcessLoop } from "./process.js";
import { EventBus } from "./events.js";
import { DeviceGateway } from "./devices.js";
import { failedMessageSteer } from "./outbox.js";
import { gatherStatus, renderStatus } from "./status.js";
import { LaneLocks } from "./locks.js";
import { runWorkLoop } from "./work.js";
import { SteerQueue } from "./steer.js";
import { HostSessions } from "./sessions.js";
import { HelperReports } from "./helper-reports.js";
import type { FileStore } from "./files.js";
import { answerCap, clearWatch, recordWatch, watchOf } from "./watches.js";
import { yieldReminder } from "./yield-reminder.js";
import { ToolDebounce } from "./tool-debounce.js";
import { blockOpenJob, settleWakeJobs } from "./jobs.js";
import { executeTool, type ToolContext, type ToolExecResult } from "./tools.js";
import type { ToolCallerKind } from "../tools/shared.js";
import { TranscriptStore } from "./transcript.js";
import { Wake, WakeStore, type WakeLimits } from "./wake.js";
import { ROUTER_KEY } from "./router.js";
import { laneRequest, runStep, syncWake, type StepDeps } from "./step.js";
import { FORWARD_ATTACHMENT, SEND_MESSAGE, type AgentStatus, type WakeOrigin } from "../types/domain.js";
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
  locks: LaneLocks;
  steer: SteerQueue;
  transcript: TranscriptStore;
  events: EventBus;
  devices: DeviceGateway;
  sessions: HostSessions;
  files: FileStore;
  /** Follows Nas's event stream and delivers helper reports to their agents. */
  helperReports: HelperReports;
  scheduler: Scheduler;
  /**
   * Queue a lane run; returns the id of the wake it joins. `reason` is why, for the wake's
   * first line; `origin` is why, as the wake's row records it when the run creates the wake
   * (manual when left out), and is ignored when the run joins a wake already running.
   */
  enqueueProcess: (agentId: string, reason?: string, origin?: WakeOrigin) => string;
  enqueueWork: (agentId: string, reason?: string, origin?: WakeOrigin) => string;
  /** Coalesced `wake_activity` events (see wake-activity.ts). */
  wakeActivity: WakeActivity;
  /** The id of the agent's current wake, or null when it has none. */
  wakeOf: (agentId: string) => string | null;
  /** The agent's status block data (see status.ts), for `GET /agents`. */
  statusOf: (agentId: string) => Promise<AgentStatus>;
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
  /** Per agent, the trigger seq of its latest routine, until anyone else's message or another schedule's wake ends it (see enqueue). */
  const lastRoutine = new Map<string, number>();
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
   * Always schedule a process-lane run. The lane lock serializes concurrent wakes;
   * dropping here would lose a second user message that arrives while busy. Returns
   * the id of the wake the run joins: the agent's current one, or a new one.
   */
  function enqueueProcess(agentId: string, reason?: string, origin?: WakeOrigin): string {
    return enqueue(agentId, "process", reason, origin);
  }

  function enqueueWork(agentId: string, reason?: string, origin?: WakeOrigin): string {
    return enqueue(agentId, "work", reason, origin);
  }

  /**
   * enqueue queues a lane run on the agent's wake, creating the wake when it has none. A wake
   * a repeating schedule's trigger creates is a routine (see Wake.routine) until a message
   * from anyone but the agent itself joins it: then someone is asking, and it is a job. Under
   * `runtime.routine_follow_up` a wake the agent's own notice creates after a routine, with no
   * one else's message since (see lastRoutine), is that routine again.
   */
  function enqueue(agentId: string, lane: Lane, reason: string | undefined, origin: WakeOrigin | undefined): string {
    const created = wakes.peek(agentId) === undefined;
    const trigger = created && origin !== undefined ? routineTrigger(agentId, origin) : null;
    const release = wakes.hold(agentId);
    const wake = wakes.get(agentId);
    wake.noteReason(reason);
    if (created) {
      beginWake(agentId, wake, origin ?? MANUAL_ORIGIN);
      wake.ownNotice = isOwnNotice(agentId, origin);
      wake.routine = trigger ?? (isOwnNotice(agentId, origin) ? (lastRoutine.get(agentId) ?? null) : null);
      if (origin?.kind === "schedule") {
        noteRoutine(agentId, trigger);
      }
    } else if (origin?.kind === "message" && origin.ref !== agentId) {
      wake.routine = null;
    }
    if (origin?.kind === "message" && origin.ref !== agentId) {
      lastRoutine.delete(agentId);
    }
    track(runLane(agentId, lane, release));
    return wake.id;
  }

  /** isOwnNotice is true when `origin` is the agent's own notice: a helper report, a wait timeout or an async result. */
  function isOwnNotice(agentId: string, origin: WakeOrigin | undefined): boolean {
    return origin?.kind === "message" && origin.ref === agentId;
  }

  /** noteRoutine remembers `trigger`, the seq that opened the agent's latest schedule wake, or forgets the routine when that wake is not one. */
  function noteRoutine(agentId: string, trigger: number | null): void {
    if (opts.config.runtime.routine_follow_up && trigger !== null) {
      lastRoutine.set(agentId, trigger);
    } else {
      lastRoutine.delete(agentId);
    }
  }

  /** workIsLive is true when the agent's work lane is running, or waits on something other than the agent itself. */
  async function workIsLive(agentId: string): Promise<boolean> {
    if (locks.isBusy(agentId, "work")) {
      return true;
    }
    const watch = await watchOf(opts.db, agentId);
    return watch !== undefined && watch.targets.some((target) => target !== agentId);
  }

  /**
   * routineTrigger is the seq of the message that opened a wake with `origin` when it is a
   * repeating schedule's trigger, else null. The trigger is in the transcript already: delivery
   * ingests a message before it queues the run.
   */
  function routineTrigger(agentId: string, origin: WakeOrigin): number | null {
    if (origin.kind !== "schedule" || origin.openedByMessageId === null) {
      return null;
    }
    const trigger = transcript.transcriptFor(agentId).find((row) => row.id === origin.openedByMessageId);
    if (trigger === undefined) {
      throw new Error(`scheduled message ${origin.openedByMessageId} that woke ${agentId} is not in its transcript`);
    }
    return trigger.routine === undefined ? null : trigger.seq;
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
   * finishWake closes the wake's row and announces its outcome: failed when a lane died,
   * waiting when the work lane watches a task or agent, else yielded.
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

  function statusOf(agentId: string): Promise<AgentStatus> {
    return gatherStatus(
      { db: opts.db, nas: opts.nas, locks, transcript, wake: wakes.peek(agentId), ledger: opts.config.runtime.status_job_ledger },
      agentId,
    );
  }

  const deliverDeps = { db: opts.db, transcript, events, enqueueProcess, enqueueWork, wakeActivity };
  const scheduler = createScheduler({
    db: opts.db,
    transcript,
    events,
    enqueueProcess,
    enqueueWork,
    wakeActivity,
    log: opts.log,
    tickSeconds: opts.config.schedule.tick_seconds,
    watches: { deliver: deliverDeps, nas: opts.nas, jobRequester: opts.config.runtime.job_requester, questionAnswerMinutes: opts.config.runtime.question_answer_minutes },
    sweep: async (now) => {
      const swept = await sweepCaches(files, opts.config.files.cache_retention_days, now);
      opts.log.info({ code: "cache_swept", files: swept }, "cache sweep done");
    },
    pickups: opts.config.runtime.hath_pickups
      ? async (now) => {
          const sent = await sendPickups(deliverDeps, now, opts.config.runtime.pickup_delay_s * 1000, opts.config.runtime.pickup_live_work ? workIsLive : null);
          if (sent > 0) {
            opts.log.info({ code: "pickups_sent", count: sent }, "hath sent pickups for overdue jobs");
          }
        }
      : null,
  });

  const helperReports = new HelperReports({
    nas: opts.nas,
    deliver: deliverDeps,
    files: { dwar: opts.dwar, files },
    log: opts.log,
  });

  const runtime: Runtime = {
    locks,
    steer,
    transcript,
    events,
    devices,
    sessions,
    files,
    helperReports,
    scheduler,
    enqueueProcess,
    enqueueWork,
    wakeActivity,
    wakeOf,
    statusOf,
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
      nas: opts.nas,
      dwar: opts.dwar,
      devices,
      steer,
      locks,
      transcript,
      events,
      sessions,
      files,
      callId: null,
      background,
      toolDebounce,
      enqueueProcess,
      enqueueWork,
      wakeActivity,
      routineSince: opts.config.runtime.routine_silence && callerId !== null ? (wakes.peek(callerId)?.routine ?? null) : null,
      directAgentMessages: opts.config.runtime.direct_agent_messages,
      ingestResultWakes: opts.config.runtime.ingest_result_wakes,
      directAnkurMessages: opts.config.runtime.direct_ankur_messages,
      hathPickups: opts.config.runtime.hath_pickups,
      questionAnswerMinutes: opts.config.runtime.question_answer_minutes,
      weekdayGuard: opts.config.runtime.weekday_guard,
      wakeId: callerId === null ? null : wakes.idOf(callerId),
      jobRequester: opts.config.runtime.job_requester,
      waitTargetGuard: opts.config.runtime.wait_target_guard,
      toolHygiene: opts.config.runtime.tool_hygiene,
      syncIngest: opts.config.runtime.sync_ingest,
      ingestSourceText: opts.config.runtime.ingest_source_text,
    };
  }

  /**
   * Acquire the lane lock and run the work lane or the process lane. `releaseWake` is
   * this run's hold on the agent's shared wake, taken when the run was queued
   * and released last, after any follow-up run has taken its own hold. Only a
   * work-lane run that finished its loop queues a follow-up for steers that
   * arrived after its last drain; a run that failed, or found the agent missing
   * or retired, leaves them for the next wake instead of re-queuing itself forever.
   * The run that holds the wake last settles the jobs the wake left open
   * before releasing it (see settleJobs); a failure is logged, since the wake must still
   * release.
   * Runs wait for the lane lock without a deadline, so no queued wake is dropped. A retired
   * agent's process lane still runs while a work-lane message waits, so a worker that retired
   * itself in the turn that queued its result still gets that report sent.
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
        const sendsLastReport = lane === "process" && (await pendingOutbox(opts.db, agentId)).length > 0;
        if (!agent || (!agent.active && !sendsLastReport)) {
          return;
        }
        if (lane === "work") {
          await runWorkLoop(workDeps(agentId));
          reasoned = true;
        } else {
          await runProcessLoop(processDeps(agentId));
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
      if (lane === "process") {
        await failOutbox(agentId, message).catch((outboxErr: unknown) => {
          opts.log.error({ err: outboxErr, agentId, code: "outbox_fail_failed" }, "recording failed work-lane messages failed");
        });
      }
      wakes.peek(agentId)?.noteError(`${lane} lane failed: ${message}`);
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
        enqueueWork(agentId, undefined, { kind: "steer", ref: null, openedByMessageId: null });
      }
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
   * failOutbox records the work-lane messages a failed process lane left unsent as failed,
   * and queues a steer telling the work lane each was not sent. It does not wake that
   * lane: a process lane that keeps failing would otherwise be handed the same work again
   * and again, so the steer waits for the agent's next wake, and the failure is reported
   * to its requester like any other lane failure.
   */
  async function failOutbox(agentId: string, message: string): Promise<void> {
    for (const row of await failPendingOutbox(opts.db, agentId, message)) {
      steer.append(agentId, failedMessageSteer(row, message));
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
      deliverDeps,
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
      assemble: async () => {
        const wake = wakes.get(agentId);
        const assembled = await assembleContext({
          db: opts.db,
          agentId,
          lane,
          transcript,
          serviceRoot: opts.config.serviceRoot,
          windows: {
            process: {
              chars: Number.MAX_SAFE_INTEGER,
              stepChars: opts.config.runtime.transcript_window_step_chars,
              budgetTokens: opts.config.runtime.process_context_tokens,
              minChars: opts.config.runtime.process_window_min_chars,
            },
            work: {
              chars: opts.config.runtime.work_transcript_window_chars,
              stepChars: opts.config.runtime.transcript_window_step_chars,
              budgetTokens: wakeLimits.promptCeilingTokens - wakeLimits.promptTrimTokens,
              minChars: 0,
            },
          },
        });
        if (!opts.config.runtime.job_did_carry || wake.started || !wake.ownNotice) {
          return assembled;
        }
        const carried = await carriedWork(opts.db, transcript, { agentId, wakeId: wake.id, routineSeq: wake.routine, filesDir: opts.config.files.dir });
        return carried === null ? assembled : { ...assembled, carried };
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
   * which belongs to no conversation. Loops the router lane on Dwar's context-free
   * chat/complete until it yields. Runs are serialized. Nothing caps the loop.
   */
  async function route(content: string): Promise<RoutedMessage[]> {
    const release = await locks.acquire(ROUTER_KEY, "router", opts.config.runtime.lane_queue_timeout_ms);
    try {
      await insertUtterance(opts.db, content);

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
        arrivalsSince: (afterSeq: number) => ({ turn: null, sent: null, sentByWork: null, throughSeq: afterSeq }),
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

  function workDeps(agentId: string) {
    return {
      ...stepDeps(agentId, "work"),
      call: (request: DwarChatRequest, signal?: AbortSignal) => opts.dwar.work(request, `hath/${agentId}`, signal),
      steer,
      woke: () => clearWatch(opts.db, agentId),
      yieldReminder: () => yieldReminder({ db: opts.db, nas: opts.nas, transcript }, agentId),
      implicitYield: opts.config.runtime.implicit_yield,
      implicitSteerEnd: opts.config.runtime.implicit_steer_end,
      wait: async (targets: string[], minutes: number) => {
        await recordWatch(opts.db, agentId, targets, await answerCap(toolContext(agentId, "work"), minutes));
      },
    };
  }

  function processDeps(agentId: string) {
    return {
      ...stepDeps(agentId, "process"),
      call: (request: DwarChatRequest) => opts.dwar.process(request, `hath/${agentId}`),
      db: opts.db,
      transcript,
      status: async () => renderStatus(await statusOf(agentId)),
      directAgentMessages: opts.config.runtime.direct_agent_messages,
      implicitYield: opts.config.runtime.implicit_yield,
    };
  }

  return runtime;
}
