/** Shared tool result helpers and agent lookup used by handlers. */

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentTools, agents } from "../db/schema.js";
import { HathError } from "../errors.js";
import type { Lane } from "../types/domain.js";
import type { EventBus } from "../runtime/events.js";
import type { LaneLocks } from "../runtime/locks.js";
import type { SteerQueue } from "../runtime/steer.js";
import type { IntentQueue } from "../runtime/intents.js";
import type { TranscriptStore } from "../runtime/transcript.js";
import type { BrowserDriver } from "../browser/driver.js";
import type { DwarClient } from "../dwar/client.js";
import type { ChaaviClient } from "../chaavi/client.js";
import type { GharClient } from "../ghar/client.js";
import type { NasClient } from "../nas/client.js";
import type { YaadClient } from "../yaad/client.js";
import type { DeviceGateway } from "../runtime/devices.js";
import type { HostSessions } from "../runtime/sessions.js";
import type { ToolDebounce } from "../runtime/tool-debounce.js";
import { toolId } from "./sync.js";

export type ToolExecResult = {
  content: string;
  isError: boolean;
  /** Extra fields merged into the durable tool_result log row. */
  audit: Record<string, unknown>;
};

/** Who is invoking a tool: an agents-row kebab id, or a synthetic CLI identity. */
export type ToolCallerKind = "agent" | "router" | "user";

export type ToolContext = {
  db: Db;
  /** Agent kebab-case id when `callerKind` is `agent`; null for `router` and `user`. */
  callerId: string | null;
  /** Distinguishes synthetic CLI callers when `callerId` is null. */
  callerKind: ToolCallerKind;
  lane: Lane;
  yaad: YaadClient;
  ghar: GharClient;
  chaavi: ChaaviClient;
  nas: NasClient;
  dwar: DwarClient;
  browsers: BrowserDriver;
  devices: DeviceGateway;
  steer: SteerQueue;
  intents: IntentQueue;
  locks: LaneLocks;
  transcript: TranscriptStore;
  events: EventBus;
  sessions: HostSessions;
  toolDebounce: ToolDebounce;
  enqueueConversation: (agentId: string) => void;
  enqueueReasoning: (agentId: string) => void;
};

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

/** Ensure agentId holds a grant for toolName or throw `403 forbidden`. */
export async function requireToolGrant(db: Db, agentId: string, toolName: string) {
  const rows = await db
    .select({ agentId: agentTools.agentId })
    .from(agentTools)
    .where(and(eq(agentTools.agentId, agentId), eq(agentTools.toolId, toolId(toolName))));
  if (!rows[0]) {
    throw new HathError(403, "forbidden", `agent does not hold ${toolName}`);
  }
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
