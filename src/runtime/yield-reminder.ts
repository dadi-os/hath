/**
 * The yield reminder (a reminder, not a gate). An agent that yields while its job has no answer
 * for the requester, and nothing it started would wake it, would sleep until some unrelated
 * wake; on 2026-10-24 agents did that for hours. So the agent's first such yield is answered
 * once with a note naming the unanswered job (see loop.ts).
 */

import { eq } from "drizzle-orm";
import { formatISO } from "date-fns";
import type { Db } from "../db/client.js";
import { reminders } from "../db/schema.js";
import type { NasClient } from "../nas/client.js";
import { hasPendingAsync } from "./async.js";
import { hasRequester, jobById } from "./jobs.js";
import { jobLedger } from "./ledger.js";
import { pendingItems } from "./pending.js";
import { watchOf } from "./watches.js";

/** What the job's opening message is quoted as. */
const QUOTE_CHARS = 200;

export type YieldReminderDeps = {
  db: Db;
  nas: NasClient;
};

/**
 * yieldReminder is the note for `agentId`'s yield in job `jobId`, or null when it needs none:
 * the wake is on no job, the job is closed, parked or has no requester (a routine's), the
 * requester was told something, or something is pending that wakes the agent: an ask no one
 * answered, a helper task still working, a wait, a reminder of its own, or an async tool call
 * still running. A Nas that cannot be read is an error.
 */
export async function yieldReminder(deps: YieldReminderDeps, agentId: string, jobId: string | null): Promise<string | null> {
  if (jobId === null) {
    return null;
  }
  const job = await jobById(deps.db, jobId);
  if (job.state !== "open" || !hasRequester(job)) {
    return null;
  }
  const ledger = await jobLedger(deps.db, job);
  if (ledger.told.length > 0 || (await somethingWillWake(deps, agentId, jobId))) {
    return null;
  }
  const quote = ledger.opened.content.length > QUOTE_CHARS ? `${ledger.opened.content.slice(0, QUOTE_CHARS)}…` : ledger.opened.content;
  return `[continue] ${ledger.requester ?? "Ankur"} asked "${quote}" at ${formatISO(new Date(ledger.opened.at))} and nothing you started will wake you. Answer now, or start or wait on what will.`;
}

/** somethingWillWake is true when anything pending would wake `agentId` on its own. */
async function somethingWillWake(deps: YieldReminderDeps, agentId: string, jobId: string): Promise<boolean> {
  if ((await watchOf(deps.db, agentId)) !== undefined || (await hasPendingAsync(deps.db, agentId))) {
    return true;
  }
  const later = await deps.db.select({ id: reminders.id }).from(reminders).where(eq(reminders.agentId, agentId)).limit(1);
  if (later.length > 0) {
    return true;
  }
  const pending = await pendingItems(deps.db, deps.nas, jobId);
  return pending.asks.length + pending.tasks.length > 0;
}
