/**
 * The yield reminder (a reminder, not a gate). An agent that yields while its requester's
 * latest message has no reply from it, and nothing it started would wake it, would sleep
 * until some unrelated wake; on 2026-10-24 agents did that for hours. So the work lane's
 * first such yield is answered once with a note naming the unanswered message (see work.ts).
 */

import { and, eq, isNull } from "drizzle-orm";
import { formatISO } from "date-fns";
import type { Db } from "../db/client.js";
import { pendingOutbox } from "../db/outbox.js";
import { currentRequester } from "../db/messages.js";
import { scheduledMessages } from "../db/schema.js";
import type { NasClient } from "../nas/client.js";
import { hasPendingAsync } from "./async.js";
import type { TranscriptStore } from "./transcript.js";
import { watchOf } from "./watches.js";

/** What the requester's message is quoted as. */
const QUOTE_CHARS = 200;

export type YieldReminderDeps = {
  db: Db;
  nas: NasClient;
  transcript: TranscriptStore;
};

/**
 * yieldReminder is the note for `agentId`'s yield, or null when it needs none: its requester's
 * latest message was answered, or something is pending that wakes the agent, which is a
 * helper task of its still working, a wait, a one-shot scheduled message to it, an async
 * tool call still running, or a message its process lane has yet to send. Recurring
 * schedules do not count, since a routine does not answer anyone. A failed read of Nas's
 * tasks counts as pending: the reminder is advisory, and a wrong one costs a model call.
 */
export async function yieldReminder(deps: YieldReminderDeps, agentId: string): Promise<string | null> {
  const requester = await currentRequester(deps.db, agentId);
  const thread = deps.transcript.transcriptFor(agentId);
  const asked = thread
    .filter((row) => row.kind === "message" && row.toAgentId === agentId && row.fromAgentId === requester)
    .at(-1);
  if (asked === undefined || thread.some((row) => row.seq > asked.seq && row.fromAgentId === agentId && row.toAgentId === requester)) {
    return null;
  }
  if (await somethingWillWake(deps, agentId)) {
    return null;
  }
  const quote = asked.content.length > QUOTE_CHARS ? `${asked.content.slice(0, QUOTE_CHARS)}…` : asked.content;
  return `[continue] ${requester ?? "Ankur"} asked "${quote}" at ${formatISO(asked.createdAt)} and nothing you started will wake you. Answer now, or start or wait on what will.`;
}

/** somethingWillWake is true when anything pending would wake `agentId` on its own. */
async function somethingWillWake(deps: YieldReminderDeps, agentId: string): Promise<boolean> {
  if ((await watchOf(deps.db, agentId)) !== undefined || (await hasPendingAsync(deps.db, agentId))) {
    return true;
  }
  if ((await pendingOutbox(deps.db, agentId)).length > 0) {
    return true;
  }
  const scheduled = await deps.db
    .select({ id: scheduledMessages.id })
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.toAgentId, agentId), isNull(scheduledMessages.intervalMinutes)))
    .limit(1);
  if (scheduled.length > 0) {
    return true;
  }
  try {
    return (await deps.nas.listTasks()).some(
      (task) => task.status === "working" && (task.owner === agentId || task.steered_by === agentId),
    );
  } catch {
    return true;
  }
}
