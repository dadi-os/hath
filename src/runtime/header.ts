/**
 * The wake header: the top of every wake, rendered by hath with no model call. It says why the
 * agent woke and which job this is (who asked, their words, what the agent has done in it), then
 * shows the current time, then lists what the agent did in the last day across jobs. A routine's job shows the routine and its
 * procedure instead of a requester.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { routines } from "../db/schema.js";
import type { JobLedger } from "../types/domain.js";
import { activityBudgetChars, activityLine, activityRows, localTime } from "./activity.js";
import { jobById } from "./jobs.js";
import { jobLedger } from "./ledger.js";
import { routineBlock } from "./routines.js";

/** What the header reads. */
export type HeaderDeps = {
  db: Db;
  agentId: string;
  /** Why the wake began, in the order the reasons arrived. */
  reasons: string[];
  /** The wake's job, or null when its reason is no job's. */
  jobId: string | null;
  /** True when the wake's reason opened that job. */
  jobIsNew: boolean;
  now: Date;
  /** `runtime.activity_hours`. */
  activityHours: number;
  /** `runtime.activity_ceiling_share` and `runtime.prompt_ceiling_tokens`. */
  activityShare: number;
  ceilingTokens: number;
};

/** The label that opens the activity list. */
export const ACTIVITY_LABEL = "[Your recent activity, last";

function who(requester: string | null): string {
  return requester === null ? "Ankur" : requester;
}

/** jobLines is the `[Job]` lines for a job that has a requester. */
function jobLines(ledger: JobLedger): string[] {
  const asked =
    ledger.asks.length === 0
      ? "none"
      : ledger.asks.map((ask) => `${ask.to} #${ask.seq} (${ask.answered_seq === null ? "no answer yet" : `answered #${ask.answered_seq}`})`).join(", ");
  const told =
    ledger.told.length === 0
      ? "nothing yet"
      : ledger.told.map((row) => `#${row.seq} "${row.preview}"`).join(", ");
  const requester = who(ledger.requester);
  const due = ledger.answer_by === null ? "" : ` · answer by ${localTime(new Date(ledger.answer_by))}`;
  const stopped = ledger.stopped === null ? "" : ` · stopped by ${ledger.stopped.by} at ${localTime(new Date(ledger.stopped.at))}`;
  return [
    `[Job #${ledger.job}] opened by ${requester}, ${localTime(new Date(ledger.opened.at))}: "${ledger.opened.content}"${due}${stopped}`,
    `  asked: ${asked}`,
    `  helpers: ${ledger.helpers.length === 0 ? "none" : ledger.helpers.join(", ")} · stored: ${ledger.stored.length === 0 ? "none" : ledger.stored.map((title) => `"${title}"`).join(", ")} · told ${requester}: ${told}${ledger.reminders.length === 0 ? "" : ` · reminders: ${ledger.reminders.map((at) => localTime(new Date(at))).join(", ")}`}`,
  ];
}

/** renderHeader is the wake's header turn: `[Wake]`, the job, the current time and the recent activity. */
export async function renderHeader(deps: HeaderDeps): Promise<string> {
  const reason = deps.reasons.length === 0 ? "no reason recorded" : deps.reasons.join("; ");
  const lines: string[] = [];
  if (deps.jobId === null) {
    lines.push(`[Wake] ${reason} · no job`);
  } else {
    const job = await jobById(deps.db, deps.jobId);
    const ledger = await jobLedger(deps.db, job);
    if (job.routineId !== null) {
      lines.push(`[Wake] ${reason} · job #${ledger.job} (routine, no requester)`);
      const [routine] = await deps.db.select().from(routines).where(eq(routines.id, job.routineId));
      lines.push(routine === undefined ? "This routine has been removed." : await routineBlock(deps.db, routine, job.id));
    } else if (job.requesterId === job.agentId) {
      lines.push(`[Wake] ${reason} · job #${ledger.job} (no requester)`);
    } else {
      lines.push(`[Wake] ${reason} · job #${ledger.job} (${deps.jobIsNew ? "new" : "continues"})`);
      lines.push(...jobLines(ledger));
    }
  }
  lines.push(`[Now] ${localTime(deps.now)}`);
  const since = new Date(deps.now.getTime() - deps.activityHours * 3_600_000);
  const rows = await activityRows(deps.db, {
    agentId: deps.agentId,
    since,
    maxChars: activityBudgetChars(deps.ceilingTokens, deps.activityShare),
  });
  lines.push(`${ACTIVITY_LABEL} ${deps.activityHours} h] ${rows.length === 0 ? "none" : rows.map(activityLine).join(" · ")}`);
  return lines.join("\n");
}
