/**
 * The activity record: what an agent did, written by hath from tool results and never by the
 * agent. The wake header lists the last day of it (see header.ts) and `my_activity` reads it,
 * so "when did you last read D2L" is answered from a record, not from memory or logs.
 */

import { randomUUID } from "node:crypto";
import { format } from "date-fns";
import { and, desc, eq, gte, ilike, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentActivity, type ActivityRow } from "../db/schema.js";
import type { ActivityKind } from "../types/domain.js";
import { PROSE_CHARS_PER_TOKEN } from "./wake.js";

/** How much of a read's answer, and of a sent message, an activity row keeps. */
const READ_DIGEST_CHARS = 300;
const SEND_DIGEST_CHARS = 160;
/** How much a recall digest keeps. */
const RECALL_DIGEST_CHARS = 1_200;

/** The local time an activity line shows: "Sat Nov 14 4:15 AM". */
export function localTime(at: Date): string {
  return format(at, "EEE MMM d h:mm a");
}

function clip(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit)}…`;
}

/** recordActivity writes one row of what `agentId` did, in job `jobId` (null for none). */
export async function recordActivity(
  db: Db,
  row: { agentId: string; jobId: string | null; kind: ActivityKind; subject: string; digest: string; at?: Date },
): Promise<void> {
  await db.insert(agentActivity).values({
    id: randomUUID(),
    agentId: row.agentId,
    jobId: row.jobId,
    kind: row.kind,
    subject: row.subject,
    digest: row.digest,
    ...(row.at !== undefined ? { at: row.at } : {}),
  });
}

const HOST = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|edu|net|io|gov|dev|app|us|co|ai|cloud)\b/gi;

/** hostsIn is the host names that appear in `texts`, lowercased, each once, in order. */
export function hostsIn(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(HOST)) {
      found.add(match[0].toLowerCase());
    }
  }
  return [...found];
}

/**
 * siteReadRow is the activity row for a browser helper's report: the hosts its steer and
 * answer name (the task's address when they name none), and the start of the answer, marked
 * ok when the helper finished and else with the state it ended in (`not_read`).
 */
export function siteReadRow(report: { task: string; state: string; text: string }, steer: string): Pick<ActivityRow, "kind" | "subject" | "digest"> {
  const hosts = hostsIn(steer, report.text);
  const outcome = report.state === "done" ? "ok" : `not_read (${report.state})`;
  return {
    kind: "site_read",
    subject: hosts.length === 0 ? report.task : hosts.join(", "),
    digest: `${report.task} ${outcome}: ${clip(report.text, READ_DIGEST_CHARS)}`,
  };
}

/** The shape of a stored operation in Yaad's ingest result that a digest reads. */
type StoredOp = { op?: unknown; title?: unknown; id?: unknown; node_id?: unknown; detail?: { closes_at?: unknown } | null };

/** closesLine is " closes Sat Nov 14 11:59 PM" for an ISO close time, or nothing when there is none. */
function closesLine(closesAt: unknown): string {
  if (typeof closesAt !== "string") {
    return "";
  }
  const at = new Date(closesAt);
  return Number.isNaN(at.getTime()) ? "" : ` closes ${localTime(at)}`;
}

/**
 * storeRow is the activity row for an ingest result (the JSON `ingest_memory` returned): the
 * nodes it created or changed, each with its id and local close time. Null when it stored none.
 */
export function storeRow(result: string): Pick<ActivityRow, "kind" | "subject" | "digest"> | null {
  const parsed = JSON.parse(result) as { operations?: StoredOp[] };
  const changed = (parsed.operations ?? []).filter(
    (op): op is StoredOp & { title: string } => (op.op === "create_node" || op.op === "update_node") && typeof op.title === "string",
  );
  if (changed.length === 0) {
    return null;
  }
  return {
    kind: "store",
    subject: changed.map((op) => op.title).join("; "),
    digest: changed
      .map((op) => `${op.title}${closesLine(op.detail?.closes_at)} [${String(op.id ?? op.node_id ?? "")}]`)
      .join("; "),
  };
}

/** The shape of a recalled node a digest reads. */
type RecalledNode = { id?: unknown; kind?: unknown; title?: unknown; detail?: { closes_at?: unknown } | null };

/**
 * recallDigestRow is the activity row for a recall by `relevant_on`: the tasks it returned with
 * their local close times, those closing on that local day first, then the later ones. Null when
 * the recall was not by date or returned no task.
 */
export function recallDigestRow(
  input: { relevant_on?: string | undefined },
  result: string,
): Pick<ActivityRow, "kind" | "subject" | "digest"> | null {
  if (input.relevant_on === undefined) {
    return null;
  }
  const nodes = ((JSON.parse(result) as { nodes?: RecalledNode[] }).nodes ?? []).filter(
    (node): node is RecalledNode & { title: string } => node.kind === "task" && typeof node.title === "string",
  );
  if (nodes.length === 0) {
    return null;
  }
  const day = (node: RecalledNode) => {
    const closes = node.detail?.closes_at;
    return typeof closes === "string" ? format(new Date(closes), "yyyy-MM-dd") : null;
  };
  const line = (node: RecalledNode & { title: string }) => `${node.title}${closesLine(node.detail?.closes_at)}`;
  const due = nodes.filter((node) => day(node) === input.relevant_on).map(line);
  const upcoming = nodes.filter((node) => day(node) !== input.relevant_on).map(line);
  const digest = [`due on ${input.relevant_on}: ${due.length === 0 ? "none" : due.join("; ")}`, ...(upcoming.length === 0 ? [] : [`open: ${upcoming.join("; ")}`])].join(" | ");
  return { kind: "recall_digest", subject: `relevant_on ${input.relevant_on}`, digest: clip(digest, RECALL_DIGEST_CHARS) };
}

/** sendRow is the activity row for a message sent to `to` (null is Ankur). */
export function sendRow(to: string | null, content: string): Pick<ActivityRow, "kind" | "subject" | "digest"> {
  return { kind: "send", subject: to ?? "ankur", digest: clip(content, SEND_DIGEST_CHARS) };
}

/**
 * activityBudgetChars is how many characters the activity list may take: `share` of the
 * prompt ceiling, which is `ceilingTokens` tokens.
 */
export function activityBudgetChars(ceilingTokens: number, share: number): number {
  return Math.floor(ceilingTokens * share * PROSE_CHARS_PER_TOKEN);
}

/** One activity row as a line: "site_read d2l.msu.edu 4:34 AM (digest)". */
export function activityLine(row: Pick<ActivityRow, "at" | "kind" | "subject" | "digest">): string {
  return `${row.kind} ${row.subject} ${localTime(row.at)} (${row.digest})`;
}

/**
 * activityRows is `agentId`'s activity newest first, from `since` on when given, narrowed to a
 * kind and to rows whose subject names `host`, as many as fit in `maxChars` of lines.
 */
export async function activityRows(
  db: Db,
  args: { agentId: string; since?: Date; kind?: ActivityKind; host?: string; maxChars: number },
): Promise<ActivityRow[]> {
  const conditions: SQL[] = [eq(agentActivity.agentId, args.agentId)];
  if (args.since !== undefined) {
    conditions.push(gte(agentActivity.at, args.since));
  }
  if (args.kind !== undefined) {
    conditions.push(eq(agentActivity.kind, args.kind));
  }
  if (args.host !== undefined) {
    conditions.push(ilike(agentActivity.subject, `%${args.host}%`));
  }
  const rows = await db
    .select()
    .from(agentActivity)
    .where(and(...conditions))
    .orderBy(desc(agentActivity.at), desc(agentActivity.id));
  const kept: ActivityRow[] = [];
  let size = 0;
  for (const row of rows) {
    size += activityLine(row).length + 3;
    if (size > args.maxChars && kept.length > 0) {
      break;
    }
    kept.push(row);
  }
  return kept;
}
