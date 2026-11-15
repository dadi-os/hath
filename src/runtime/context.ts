import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatISO } from "date-fns";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, jobs } from "../db/schema.js";
import { HathError } from "../errors.js";
import type { DwarChatRequest, DwarMessage } from "../types/domain.js";
import { attachmentStub } from "./attachments.js";
import { directoryBlock, ownDescriptionLine } from "./directory.js";
import type { TranscriptEntry, TranscriptStore } from "./transcript.js";
import { DATA_CHARS_PER_TOKEN, PROSE_CHARS_PER_TOKEN, type WakeTurn } from "./wake.js";
import { OPEN_STATES } from "./jobs.js";
import { agentTools, routerTools, WORKER_ID } from "./tool-set.js";
import { continuedTurns } from "./continuation.js";

const promptCache = new Map<string, { mtimeMs: number; text: string }>();

/** loadPrompt reads `prompts/<name>` under the service root, re-reading only when the file changes. Throws when empty. */
function loadPrompt(serviceRoot: string, name: string): string {
  const path = join(serviceRoot, "prompts", name);
  const { mtimeMs } = statSync(path);
  const cached = promptCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.text;
  }
  const text = readFileSync(path, "utf8").trim();
  if (!text) {
    throw new Error(`prompt ${name} is empty`);
  }
  promptCache.set(path, { mtimeMs, text });
  return text;
}

/**
 * lineageBlock states runtime facts the model cannot know on its own: who it is
 * and its parent. How the loop works, messaging discipline, and the rest of the standing
 * doctrine live in Dwar's agent block (cached, shared across agents) —
 * deliberately not restated here, so there is one source of truth.
 */
function lineageBlock(agentId: string | null, parentAgentId: string | null): string {
  if (agentId === null) {
    return "You are the router: Ankur's translator into the org, not an agent. You share his identity (null), so every message you send arrives as his, and root agents are your direct children.";
  }
  const parentLine =
    parentAgentId === null
      ? "You are a root agent: your parent is the router."
      : `Your parent is ${parentAgentId}.`;
  return `Your agent id is ${agentId}.\n${parentLine}`;
}

/**
 * An assembled request: its system and tools, the thread the agent reads, and the newest
 * thread seq it includes (0 when empty).
 */
export type AssembledContext = Omit<DwarChatRequest, "tool_choice" | "messages"> & {
  thread: DwarMessage[];
  throughSeq: number;
  /** The wake header (see header.ts), rendered when the wake begins. */
  header?: string;
  /** The steps the job's earlier wakes took, when the wake continues a job (see continuation.ts). */
  continued?: WakeTurn[];
  /**
   * What arrived after the job's last step, folded into one turn, when the wake continues a
   * job: it follows `continued`, so the arrival that woke the agent is the last thing it reads.
   * `thread` then holds only what came before that step.
   */
  arrived?: DwarMessage;
};

/**
 * hath's system for an identity, in order: the system doctrine
 * (`prompts/system.md`, shared by everyone), the charter (an agent's stored
 * prompt, or `prompts/router.md` for the router), lineage facts with the agent's own
 * directory entry, then the agent directory: every active agent other than workers,
 * each with the description it wrote (see directory.ts), so an agent knows who owns
 * what across the org, not only its own children. Workers come and go within a wake,
 * and listing them would change every system with each spawn and retire, so no cached
 * prompt would survive to the next wake; `list_agents` shows them.
 */
async function composeSystem(
  db: Db,
  serviceRoot: string,
  /** Null is the router. */
  agentId: string | null,
): Promise<string> {
  let charter: string;
  let parentAgentId: string | null = null;
  let description: string | null = null;
  if (agentId === null) {
    charter = loadPrompt(serviceRoot, "router.md");
  } else {
    const agentRows = await db.select().from(agents).where(eq(agents.id, agentId));
    const agent = agentRows[0];
    if (!agent) {
      throw new HathError(404, "not_found", `agent ${agentId} not found`);
    }
    charter = agent.systemPrompt;
    parentAgentId = agent.parentAgentId;
    description = agent.description;
  }

  const standing = (
    await db
      .select({
        id: agents.id,
        description: agents.description,
        systemPrompt: agents.systemPrompt,
        parentAgentId: agents.parentAgentId,
      })
      .from(agents)
      .where(eq(agents.active, true))
      .orderBy(asc(agents.id))
  ).filter((agent) => !WORKER_ID.test(agent.id));

  return [
    loadPrompt(serviceRoot, "system.md"),
    charter,
    agentId === null ? lineageBlock(agentId, parentAgentId) : `${lineageBlock(agentId, parentAgentId)}\n${ownDescriptionLine(description)}`,
    directoryBlock(standing, agentId, parentAgentId),
  ].join("\n\n");
}

/** How much of an agent's thread its window holds beside the messages of its open jobs. */
export type ThreadWindow = {
  /** The window holds the newest other messages up to about this many characters. */
  chars: number;
  /** The window's start moves in jumps of this many characters. */
  stepChars: number;
  /**
   * The system, tools and window together stay under about this many tokens: an agent
   * whose charter and tools weigh more gets a shorter window, so its first call never
   * starts over the prompt ceiling.
   */
  budgetTokens: number;
};

/**
 * windowStart is the index of the first entry a window shows: the newest entries up to
 * about `window.chars` characters. Character offsets are measured from the start of the
 * thread and cut into buckets of `window.stepChars`; the window starts at the first entry of
 * the earliest bucket that keeps it under `window.chars`. Older entries never change, so the
 * start stays put while messages are appended and only jumps when the thread
 * outgrows the window by another step, which keeps the provider's cached
 * prefix byte-stable between jumps. The newest entry is always shown.
 */
export function windowStart(sizes: number[], window: Pick<ThreadWindow, "chars" | "stepChars">): number {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= window.chars) {
    return 0;
  }
  const cutAt = Math.ceil((total - window.chars) / window.stepChars) * window.stepChars;
  let offset = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    if (offset >= cutAt) {
      return i;
    }
    offset += sizes[i]!;
  }
  return sizes.length - 1;
}

/**
 * openJobEntries is the thread entries that belong to the agent's open jobs: those stamped with
 * an open job, and what an agent it asked in one of them wrote back after the ask (a reply is
 * stamped with the asker's own job, see job-of.ts).
 */
function openJobEntries(thread: TranscriptEntry[], agentId: string, openJobIds: ReadonlySet<string>): Set<number> {
  const members = new Set<number>();
  const asked = new Set<string | null>();
  for (const row of thread) {
    const stamped = row.jobId !== null && openJobIds.has(row.jobId);
    if (row.fromAgentId === agentId && row.toAgentId !== agentId) {
      if (stamped) {
        asked.add(row.toAgentId);
        members.add(row.seq);
      }
    } else if (stamped || (row.kind !== "notice" && asked.has(row.fromAgentId))) {
      members.add(row.seq);
    }
  }
  return members;
}

/**
 * threadWindow is the thread entries an agent reads: every message of its open jobs, whole,
 * then the newest of the others up to `window.chars`, all in thread order, and never more than
 * `roomChars` (the room the prompt ceiling leaves), the oldest dropping first.
 */
export function threadWindow(
  thread: TranscriptEntry[],
  agentId: string,
  openJobIds: ReadonlySet<string>,
  window: Pick<ThreadWindow, "chars" | "stepChars">,
  roomChars: number,
): TranscriptEntry[] {
  const open = openJobEntries(thread, agentId, openJobIds);
  const others = thread.filter((row) => !open.has(row.seq));
  const chars = Math.min(window.chars, roomChars);
  const first = windowStart(
    others.map((row) => transcriptText(row, agentId).length),
    { chars, stepChars: Math.max(1, Math.min(window.stepChars, Math.floor(chars / 4))) },
  );
  const shown = new Set([...open, ...others.slice(first).map((row) => row.seq)]);
  const picked = thread.filter((row) => shown.has(row.seq));
  let total = picked.reduce((sum, row) => sum + transcriptText(row, agentId).length, 0);
  let from = 0;
  while (total > roomChars && from < picked.length - 1) {
    total -= transcriptText(picked[from]!, agentId).length;
    from += 1;
  }
  return picked.slice(from);
}

/**
 * An agent's request: its system, then its thread window (see threadWindow), no wider than
 * the room the budget leaves after the system and the tools. Messages that left the window
 * are reached through get_logs and memory. Dwar prepends its agent block as a cached block.
 * For a wake that continues a job, the job's earlier steps come with it (see continuation.ts).
 */
export async function assembleContext(opts: {
  db: Db;
  agentId: string;
  transcript: TranscriptStore;
  serviceRoot: string;
  window: ThreadWindow;
  /** The wake's id, job and files folder, when it is on a job that earlier wakes worked. */
  continuation: { wakeId: string; jobId: string; filesDir: string } | null;
}): Promise<AssembledContext> {
  const system = await composeSystem(opts.db, opts.serviceRoot, opts.agentId);
  const thread = opts.transcript.transcriptFor(opts.agentId);
  const tools = agentTools(opts.agentId);
  const openJobIds = new Set(
    (
      await opts.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.agentId, opts.agentId), inArray(jobs.state, [...OPEN_STATES])))
    ).map((row) => row.id),
  );
  const fixedTokens = Math.ceil(system.length / PROSE_CHARS_PER_TOKEN) + Math.ceil(JSON.stringify(tools).length / DATA_CHARS_PER_TOKEN);
  const roomChars = Math.floor(Math.max(0, opts.window.budgetTokens - fixedTokens) * PROSE_CHARS_PER_TOKEN);
  const shown = threadWindow(thread, opts.agentId, openJobIds, opts.window, roomChars);
  const { turns: continued, lastStepAt } = opts.continuation === null ? { turns: [], lastStepAt: null } : await continuedTurns(opts.db, { agentId: opts.agentId, ...opts.continuation });
  const split = continued.length === 0 || lastStepAt === null ? null : lastStepAt;
  const later = (row: TranscriptEntry) => split !== null && row.createdAt > split && !isOwnSend(row, opts.agentId);
  const before = shown.filter((row) => !later(row));
  const arrived = split === null ? null : foldArrivals(shown.filter(later), opts.agentId, ARRIVED_SINCE_STEP);
  return {
    system,
    thread: historyFor(before, opts.agentId),
    tools,
    throughSeq: thread.at(-1)?.seq ?? 0,
    ...(continued.length > 0 ? { continued } : {}),
    ...(arrived === null ? {} : { arrived }),
  };
}

/**
 * The router's request. The router is ephemeral: it sees its system and this
 * one utterance, never an earlier run, a message sent as Ankur, or a reply to
 * him. The org's current state reaches it only through the system and its tools.
 */
export async function assembleRouterContext(opts: {
  db: Db;
  serviceRoot: string;
  /** What Ankur just said. */
  utterance: string;
}): Promise<AssembledContext> {
  return {
    system: await composeSystem(opts.db, opts.serviceRoot, null),
    thread: [{ role: "user", content: `[From: Ankur · ${formatISO(new Date())}]\n${opts.utterance}` }],
    tools: routerTools(),
    throughSeq: 0,
  };
}

/** What arrived in an agent's thread since a seq, folded into one turn (see arrivalsSince). */
export type Arrivals = {
  /** Messages to the agent, its own notes, and what hath sent for it; null when none. */
  turn: DwarMessage | null;
  /** The newest seq seen, own messages included. */
  throughSeq: number;
};

/**
 * arrivalsSince folds thread entries newer than `afterSeq` into one user turn, so messages that
 * land mid-wake join the scratchpad at the point they arrived instead of rewriting the history
 * above it. Each is marked with its job. The agent's own sends are not folded back in: the
 * step that made each already holds the call, and hath's pickups for the agent arrive as a
 * separate line.
 */
export function arrivalsSince(transcript: TranscriptStore, agentId: string, afterSeq: number): Arrivals {
  const fresh = transcript.transcriptFor(agentId).filter((row) => row.seq > afterSeq);
  if (fresh.length === 0) {
    return { turn: null, throughSeq: afterSeq };
  }
  return { turn: foldArrivals(fresh, agentId, ARRIVED_DURING_WAKE), throughSeq: fresh.at(-1)!.seq };
}

const ARRIVED_DURING_WAKE = "[Arrived during this wake]";
const ARRIVED_SINCE_STEP = "[Arrived since your last step]";

/** isOwnSend is true for a message the agent itself sent to someone else, as opposed to one hath sent for it. */
function isOwnSend(row: TranscriptEntry, agentId: string): boolean {
  return row.fromAgentId === agentId && row.toAgentId !== agentId && row.sentBy !== "hath";
}

/**
 * foldArrivals folds thread entries into one user turn under `label`, or null when none is
 * to show: what reached the agent, then what hath sent for it. Its own sends are left out.
 */
function foldArrivals(rows: TranscriptEntry[], agentId: string, label: string): DwarMessage | null {
  const arrived = rows.filter((row) => row.fromAgentId !== agentId || row.toAgentId === agentId);
  const own = rows.filter((row) => row.fromAgentId === agentId && row.toAgentId !== agentId);
  const text = (heading: string, group: TranscriptEntry[]): string[] =>
    group.length === 0 ? [] : [heading, ...group.map((row) => transcriptText(row, agentId, true))];
  const parts = [...text(label, arrived), ...text("[Sent for you by hath]", own.filter((row) => row.sentBy === "hath"))];
  return parts.length === 0 ? null : { role: "user", content: parts.join("\n\n") };
}

/**
 * labelEntry gives a thread row its turn role and `[From:]`/`[To:]`/`[Thought]`/`[Notice from hath]`
 * label from this agent's point of view, stamped with when the row was written (ISO 8601
 * in the box's `TZ` with its offset, `2026-10-02T13:14:48-04:00`) so the agent knows the
 * date and time it is acting at. A report's job status follows the time.
 */
function labelEntry(
  row: TranscriptEntry,
  agentId: string,
  withJob: boolean,
): { role: "user" | "assistant"; label: string } {
  const stamp = row.status === null ? formatISO(row.createdAt) : `${formatISO(row.createdAt)} · ${row.status}`;
  const at = withJob && row.jobNumber !== undefined ? `${stamp} · job #${row.jobNumber}` : stamp;
  if (row.kind === "notice") {
    return { role: "user", label: `[Notice from hath · ${at}]` };
  }
  if (row.fromAgentId === agentId && row.toAgentId === agentId) {
    return { role: "assistant", label: `[Thought · ${at}]` };
  }
  if (row.toAgentId === agentId) {
    return { role: "user", label: `[From: ${row.fromAgentId === null ? "Ankur" : row.fromAgentId} · ${at}]` };
  }
  return { role: "assistant", label: `[To: ${row.toAgentId === null ? "Ankur" : row.toAgentId} · ${at}]` };
}

/** A history entry: always plain text, so its length is its size in the window. */
type TextMessage = DwarMessage & { content: string };

/**
 * historyFor is an agent's history as it reads it, oldest first: each message in `thread`
 * with its label (see transcriptText). What the agent did and read lives in its tool log,
 * which get_logs searches; the history holds what it said and was told, and the agent
 * treats its own messages as true.
 */
function historyFor(thread: TranscriptEntry[], agentId: string): TextMessage[] {
  return thread.map((row) => ({ role: labelEntry(row, agentId, false).role, content: transcriptText(row, agentId) }));
}

/** transcriptText is a transcript row as this agent reads it: its label, then its body. */
export function transcriptText(row: TranscriptEntry, agentId: string, withJob = false): string {
  return `${labelEntry(row, agentId, withJob).label}\n${entryBody(row)}`;
}

/** A transcript row's text followed by a stub per attachment it carries. */
function entryBody(row: TranscriptEntry): string {
  return [row.content, ...row.attachments.map(attachmentStub)]
    .filter((part) => part.length > 0)
    .join("\n\n");
}
