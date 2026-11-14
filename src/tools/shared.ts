/** Shared tool result helpers and agent lookup used by handlers. */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";
import { HathError } from "../errors.js";
import type { Lane, WakeOrigin } from "../types/domain.js";
import type { WakeActivity } from "../runtime/wake-activity.js";
import type { EventBus } from "../runtime/events.js";
import type { LaneLocks } from "../runtime/locks.js";
import type { SteerQueue } from "../runtime/steer.js";
import type { TranscriptStore } from "../runtime/transcript.js";
import type { DwarClient } from "../dwar/client.js";
import type { GharClient } from "../ghar/client.js";
import type { NasClient } from "../nas/client.js";
import type { YaadClient } from "../yaad/client.js";
import type { DeviceGateway } from "../runtime/devices.js";
import type { HostSessions } from "../runtime/sessions.js";
import type { FileStore } from "../runtime/files.js";
import type { ToolDebounce } from "../runtime/tool-debounce.js";

export type ToolExecResult = {
  content: string;
  isError: boolean;
  /** Extra fields merged into the durable tool_result log row. */
  audit: Record<string, unknown>;
  /**
   * Set on a successful read of state that a newer read makes stale (a tab's tree, a page's
   * text, a terminal's screen): the wake shows only the newest result under each key.
   */
  state?: string;
};

/** Who is invoking a tool: an agents-row kebab id, or the router. */
export type ToolCallerKind = "agent" | "router";

export type ToolContext = {
  db: Db;
  /** Agent kebab-case id when `callerKind` is `agent`; null for `router`. */
  callerId: string | null;
  /** Which kind of caller this is; `router` when `callerId` is null. */
  callerKind: ToolCallerKind;
  lane: Lane;
  yaad: YaadClient;
  ghar: GharClient;
  nas: NasClient;
  dwar: DwarClient;
  devices: DeviceGateway;
  steer: SteerQueue;
  locks: LaneLocks;
  transcript: TranscriptStore;
  events: EventBus;
  sessions: HostSessions;
  /** The box folder hath keeps files in, and the Nas that writes them (see runtime/files.ts). */
  files: FileStore;
  /** The id of the model's tool call being run, or null outside one. */
  callId: string | null;
  /** Keeps `work` running, and counted by waitUntilIdle, after the tool call that started it has returned. A failure is logged. */
  background: (work: Promise<void>) => void;
  toolDebounce: ToolDebounce;
  enqueueProcess: (agentId: string, reason?: string, origin?: WakeOrigin) => string;
  enqueueWork: (agentId: string, reason?: string, origin?: WakeOrigin) => string;
  /** Told of each message that opens or joins a wake (see runtime/wake-activity.ts). */
  wakeActivity?: WakeActivity;
  /**
   * While the caller's wake is a routine and `runtime.routine_silence` is on, the seq of the
   * trigger that opened it (see runtime/wake.ts Wake.routine); null otherwise. A routine sends
   * nothing to agents and at most one message to Ankur (see runtime/send.ts routineRefusal).
   */
  routineSince: number | null;
  /** `runtime.direct_agent_messages`: the work lane's `queue_message` to an agent is delivered at once (see runtime/outbox.ts). */
  directAgentMessages: boolean;
  /** `runtime.ingest_result_wakes`: a successful ingest_memory result wakes the lane that saved it (see runtime/async.ts). */
  ingestResultWakes: boolean;
  /** `runtime.direct_ankur_messages`: the work lane's `queue_message` to Ankur is delivered at once (see runtime/outbox.ts). */
  directAnkurMessages: boolean;
  /** `runtime.hath_pickups`: a message with status running is refused, since hath sends the pickup (see runtime/send.ts runningRefusal). */
  hathPickups: boolean;
  /** `runtime.question_answer_minutes`: how long after Ankur's question a wait may last (see runtime/watches.ts). */
  questionAnswerMinutes: number;
  /** `runtime.weekday_guard`: a date in a message to Ankur needs its weekday (see runtime/send.ts weekdayRefusal). */
  weekdayGuard: boolean;
  /** The id of the caller's current wake, or null for the router. */
  wakeId: string | null;
  /** `runtime.job_requester`: Ankur's question is the open job he opened under `questionAnswerMinutes` ago (see runtime/watches.ts). */
  jobRequester: boolean;
  /** `runtime.wait_target_guard`: wait refuses the caller's own id and tool call ids (see runtime/watches.ts). */
  waitTargetGuard: boolean;
  /** `runtime.tool_hygiene`: get_logs leaves out the current wake; the list tools leave out stopped tasks. */
  toolHygiene: boolean;
  /** `runtime.sync_ingest`: ingest_memory runs in the call and returns what Yaad stored (see runtime/tools.ts). */
  syncIngest: boolean;
  /** `runtime.ingest_source_text`: ingest_memory sends Yaad the text of Ankur's message that opened the open job (see runtime/memory.ts). */
  ingestSourceText: boolean;
};

/**
 * Longest message one agent may send another. Findings go in a few lines and raw
 * output travels as an attachment; messages to Ankur are not capped.
 */
export const AGENT_MESSAGE_MAX_CHARS = 4000;

/**
 * failOversizedAgentMessage refuses `content` to another agent when it passes
 * AGENT_MESSAGE_MAX_CHARS, telling the sender how to send it instead; null when it
 * may go (any length to Ankur, `toAgentId` null).
 */
export function failOversizedAgentMessage(toAgentId: string | null, content: string): ToolExecResult | null {
  if (toAgentId === null || content.length <= AGENT_MESSAGE_MAX_CHARS) {
    return null;
  }
  return fail(
    `This message to ${toAgentId} is ${content.length} characters; agent-to-agent messages stop at ${AGENT_MESSAGE_MAX_CHARS}. Send what you found in a few lines, and put raw output, logs, or long text in a file and send its path in the attachments.`,
  );
}

/** A tool result the model sees as an error. */
export function fail(message: string): ToolExecResult {
  return { content: message, isError: true, audit: {} };
}

/** A successful tool result: `value` as JSON, plus fields for the audit log. */
export function ok(value: unknown, audit: Record<string, unknown> = {}): ToolExecResult {
  return { content: JSON.stringify(value), isError: false, audit };
}

/** Fail when a tool needs an agents-row caller (`callerId` null for router/user). */
export function failWithoutAgentIdentity(): ToolExecResult {
  return fail("this tool needs an agent identity");
}

/** Load an agent row or throw `404 not_found`. */
export async function requireAgent(db: Db, id: string) {
  const rows = await db.select().from(agents).where(eq(agents.id, id));
  const row = rows[0];
  if (!row) {
    throw new HathError(404, "not_found", `agent ${id} not found`);
  }
  return row;
}

/**
 * Load an agent that has not been retired, or throw `404 not_found` /
 * `409 retired`. A retired agent does not act and cannot be messaged until its
 * parent reactivates it with manage_agent.
 */
export async function requireActiveAgent(db: Db, id: string) {
  const row = await requireAgent(db, id);
  if (!row.active) {
    throw new HathError(409, "retired", `agent ${id} is retired`);
  }
  return row;
}

/** True when err (or a nested cause) is Postgres unique_violation `23505`. */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let i = 0; i < 4; i++) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code: unknown }).code === "23505"
    ) {
      return true;
    }
    if (typeof current === "object" && current !== null && "cause" in current) {
      current = (current as { cause: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}
