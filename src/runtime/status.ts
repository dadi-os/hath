/**
 * The status block: where an agent's work stands, rendered by hath with no model call. It
 * is the last user turn of every process-lane call, and `GET /agents` exposes the same
 * data as `running.status`. The process lane never carries the work lane's scratchpad, so
 * this block is how it knows what is going on; it reads detail with get_logs and read_file.
 */

import { formatISO } from "date-fns";
import type { Db } from "../db/client.js";
import { currentRequester } from "../db/messages.js";
import { pendingOutbox } from "../db/outbox.js";
import type { NasClient } from "../nas/client.js";
import type { AgentStatus } from "../types/domain.js";
import type { LaneLocks } from "./locks.js";
import type { TranscriptStore } from "./transcript.js";
import type { Wake } from "./wake.js";
import { watchOf } from "./watches.js";

/** Opens the block; it names hath so the lane never reads it as part of a message. */
export const STATUS_LABEL = "[Status]";

/** How many of the work lane's latest tool calls the block lists. */
export const STATUS_RECENT_CALLS = 5;

/** How much of a message, an argument or a pending message the block quotes. */
const JOB_CHARS = 300;
const ARG_CHARS = 80;
const PENDING_CHARS = 120;

/** The input keys a call's short argument is taken from, first one present. */
const ARG_KEYS = ["path", "url", "query", "command", "id", "message", "to", "name", "pattern", "text", "content", "on"];

function clip(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit)}…`;
}

/** shortArg is the one argument that names what a call did: its path, URL, query, command or id, else its input clipped. */
export function shortArg(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    for (const key of ARG_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return clip(value, ARG_CHARS);
      }
      if (Array.isArray(value) && value.length > 0) {
        return clip(value.join(", "), ARG_CHARS);
      }
    }
  }
  const json = JSON.stringify(input) ?? "";
  return json === "{}" ? "" : clip(json, ARG_CHARS);
}

/** What gatherStatus reads. */
export type StatusDeps = {
  db: Db;
  nas: NasClient;
  locks: LaneLocks;
  transcript: TranscriptStore;
  /** The agent's current wake, or undefined when it has none (the work lane's steps are then unknown). */
  wake: Wake | undefined;
};

/**
 * gatherStatus reads `agentId`'s status from the live wake, the lane locks, the watches,
 * Nas and the outbox. A Nas that cannot be read is reported in `tasks_unreadable` and the
 * block says so, instead of guessing that nothing is in flight.
 */
export async function gatherStatus(deps: StatusDeps, agentId: string): Promise<AgentStatus> {
  const requester = await currentRequester(deps.db, agentId);
  const asked = deps.transcript
    .transcriptFor(agentId)
    .filter((row) => row.kind === "message" && row.toAgentId === agentId && row.fromAgentId === requester)
    .at(-1);
  const watch = await watchOf(deps.db, agentId);
  const calls = deps.wake?.workCalls(STATUS_RECENT_CALLS) ?? [];
  const last = calls.at(-1);
  const running = deps.locks.isHeld(agentId, "work");
  let tasks: AgentStatus["tasks"] = [];
  let unreadable: string | null = null;
  try {
    tasks = (await deps.nas.listTasks())
      .filter((task) => (task.owner === agentId || task.steered_by === agentId) && (task.status === "working" || task.status === "asking"))
      .map((task) => ({ id: task.task, status: task.status, current: clip(task.state, ARG_CHARS) }));
  } catch (err) {
    unreadable = err instanceof Error ? err.message : String(err);
  }
  const lastStep = deps.wake?.lastWorkAt ?? null;
  return {
    job: asked === undefined ? null : { from: requester, at: formatISO(asked.createdAt), content: clip(asked.content, JOB_CHARS) },
    work: running
      ? { state: "running", since: lastStep === null ? null : formatISO(lastStep), waiting_on: [] }
      : watch !== undefined
        ? { state: "waiting", since: formatISO(watch.since), waiting_on: watch.targets }
        : { state: "idle", since: null, waiting_on: [] },
    step: last === undefined ? null : `${last.name} ${shortArg(last.input)}`.trim(),
    recent: calls.map((call) => ({ name: call.name, arg: shortArg(call.input), ok: call.failed === null ? null : !call.failed })),
    tasks,
    tasks_unreadable: unreadable,
    pending: (await pendingOutbox(deps.db, agentId)).map((row) => ({
      id: row.id,
      to: row.toAgentId,
      expects_reply: row.expectsReply,
      preview: clip(row.content, PENDING_CHARS),
    })),
  };
}

/** renderStatus is the status block's text; a pure function of the gathered status. */
export function renderStatus(status: AgentStatus): string {
  const lines = [`${STATUS_LABEL} A note from hath, not a message: where your work lane stands right now. get_logs and read_file have detail.`];
  lines.push(
    status.job === null
      ? "Current job: none open."
      : `Current job: from ${status.job.from ?? "Ankur"} at ${status.job.at}: ${status.job.content}`,
  );
  const work = status.work;
  lines.push(
    work.state === "waiting"
      ? `Work lane: waiting on ${work.waiting_on.join(", ")} since ${work.since}.`
      : work.state === "running"
        ? `Work lane: running${work.since === null ? "" : ` (last step ${work.since})`}.`
        : "Work lane: idle.",
  );
  lines.push(status.step === null ? "Current step: none." : `Current step: ${status.step}`);
  if (status.recent.length > 0) {
    lines.push("Last tool calls:");
    for (const call of status.recent) {
      lines.push(`- ${call.name}${call.arg === "" ? "" : ` ${call.arg}`} · ${call.ok === null ? "running" : call.ok ? "ok" : "error"}`);
    }
  }
  if (status.tasks_unreadable !== null) {
    lines.push(`Helper tasks: could not be read (${status.tasks_unreadable}).`);
  } else if (status.tasks.length === 0) {
    lines.push("Helper tasks in flight: none.");
  } else {
    lines.push("Helper tasks in flight:");
    for (const task of status.tasks) {
      lines.push(`- ${task.id} · ${task.status} · ${task.current}`);
    }
  }
  if (status.pending.length === 0) {
    lines.push("Messages from work waiting to be sent: none.");
  } else {
    lines.push("Messages from work waiting to be sent:");
    for (const row of status.pending) {
      lines.push(`- #${row.id} to ${row.to ?? "Ankur"}${row.expects_reply ? " (expects a reply)" : ""}: ${row.preview}`);
    }
  }
  return lines.join("\n");
}
