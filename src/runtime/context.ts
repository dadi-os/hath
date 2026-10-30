import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatISO } from "date-fns";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents } from "../db/schema.js";
import { HathError } from "../errors.js";
import type { DwarChatRequest, DwarMessage, DwarTool, Lane } from "../types/domain.js";
import { attachmentStub } from "./attachments.js";
import { listAgentsTool, PROCESS_REGISTRY_TOOLS, steerWorkTool, yieldTool } from "./tools.js";
import { sendTool } from "./send.js";
import { waitTool } from "./watches.js";
import { directoryBlock, ownDescriptionLine } from "./directory.js";
import { messageTool } from "./outbox.js";
import { ingestMemoryTool, recallMemoryTool } from "./memory.js";
import { manageAgentTool, modifyAgentPromptTool } from "./modify.js";
import type { TranscriptEntry, TranscriptStore } from "./transcript.js";
import { DATA_CHARS_PER_TOKEN, PROSE_CHARS_PER_TOKEN } from "./wake.js";
import {
  embeddedAgentTools,
  embeddedFileReadTools,
  embeddedFileWriteTools,
  embeddedHelperTools,
  allTools,
  embeddedSchedulingTools,
  findEmbeddedTool,
} from "../tools/registry.js";
import { asDwarTool } from "../tools/types.js";
import { routerLaneTools } from "./router.js";

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
 * and its parent. Lane roles, messaging discipline, and the rest of the standing
 * doctrine live in Dwar's per-lane block (cached, shared across agents) —
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
 * An assembled lane request: its system and tools, the transcript each lane
 * sends, and the newest transcript seq they include (0 when empty). Both agent
 * lanes' transcripts are cut from the same thread at once, so whichever lane
 * begins the wake freezes both through the same message.
 */
export type AssembledContext = Omit<DwarChatRequest, "tool_choice" | "messages"> & {
  transcripts: Partial<Record<Lane, DwarMessage[]>>;
  throughSeq: number;
};

/** A worker's id names its pool and task (`browser-worker-ibio-150-quiz-2`), per the system doctrine. */
const WORKER_ID = /(^|-)worker-/;

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

/** How much of an agent's thread its transcript holds. */
export type TranscriptWindow = {
  /** The window holds the newest messages up to about this many characters. */
  chars: number;
  /** The window's start moves in jumps of this many characters. */
  stepChars: number;
  /**
   * The lane's system, tools and window together stay under about this many tokens:
   * an agent whose charter and tools weigh more gets a shorter window, so its first
   * call never starts over the prompt ceiling.
   */
  budgetTokens: number;
};

/** Each agent lane's transcript window. */
export type TranscriptWindows = Record<Exclude<Lane, "router">, TranscriptWindow>;

/**
 * windowStart is the index of the first entry an agent's transcript shows: the
 * newest entries up to about `window.chars` characters. Character offsets are
 * measured from the start of the thread and cut into buckets of
 * `window.stepChars`; the window starts at the first entry of the earliest
 * bucket that keeps it under `window.chars`. Older entries never change, so the
 * start stays put while messages are appended and only jumps when the thread
 * outgrows the window by another step, which keeps the provider's cached
 * prefix byte-stable between jumps. The newest entry is always shown.
 */
export function windowStart(sizes: number[], window: Omit<TranscriptWindow, "budgetTokens">): number {
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
 * An agent lane's request: its system, then each lane's rolling window of its
 * history (see historyFor, windowStart), no wider than the room the window's budget leaves
 * after the system and that lane's tools. The process lane's budget is the small
 * `process_context_tokens`, since it is the front desk and reads detail on demand;
 * the work lane's is the prompt ceiling less its trim. Messages that left a window are
 * reached through get_logs and memory. Dwar appends lane doctrine as a cached block.
 */
export async function assembleContext(opts: {
  db: Db;
  agentId: string;
  lane: keyof TranscriptWindows;
  transcript: TranscriptStore;
  serviceRoot: string;
  windows: TranscriptWindows;
}): Promise<AssembledContext> {
  const system = await composeSystem(opts.db, opts.serviceRoot, opts.agentId);
  const thread = opts.transcript.transcriptFor(opts.agentId);
  const messages = historyFor(thread, opts.agentId);
  const sizes = messages.map((message) => message.content.length);
  const laneTools = {
    process: toolsForLane(opts.agentId, "process"),
    work: toolsForLane(opts.agentId, "work"),
  };
  const windowed = (lane: keyof TranscriptWindows) => {
    const window = opts.windows[lane];
    const fixedTokens =
      Math.ceil(system.length / PROSE_CHARS_PER_TOKEN) +
      Math.ceil(JSON.stringify(laneTools[lane]).length / DATA_CHARS_PER_TOKEN);
    const chars = Math.min(
      window.chars,
      Math.floor(Math.max(0, window.budgetTokens - fixedTokens) * PROSE_CHARS_PER_TOKEN),
    );
    return messages.slice(windowStart(sizes, { chars, stepChars: Math.max(1, Math.min(window.stepChars, Math.floor(chars / 4))) }));
  };

  return {
    system,
    transcripts: { process: windowed("process"), work: windowed("work") },
    tools: laneTools[opts.lane],
    throughSeq: thread.at(-1)?.seq ?? 0,
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
    transcripts: {
      router: [{ role: "user", content: `[From: Ankur · ${formatISO(new Date())}]\n${opts.utterance}` }],
    },
    tools: routerLaneTools(),
    throughSeq: 0,
  };
}

/**
 * arrivalsSince folds transcript entries newer than `afterSeq` into user turns, so
 * messages that land mid-wake join the scratchpad at the point they arrived instead of
 * rewriting the history above it. `turn` is what arrived (messages to the agent, and its
 * own notes to itself) and is shown to both lanes. The agent's messages to others are not
 * arrivals: the process lane already holds the call that sent each, and folding them in
 * again woke it to read its own words back. The work lane never sees process's calls, so
 * `sent` carries those messages to it, as what its process lane sent. Each is null when
 * there is none; `throughSeq` is the newest seq seen, own messages included.
 */
export function arrivalsSince(
  transcript: TranscriptStore,
  agentId: string,
  afterSeq: number,
): { turn: DwarMessage | null; sent: DwarMessage | null; throughSeq: number } {
  const fresh = transcript.transcriptFor(agentId).filter((row) => row.seq > afterSeq);
  if (fresh.length === 0) {
    return { turn: null, sent: null, throughSeq: afterSeq };
  }
  const throughSeq = fresh.at(-1)!.seq;
  const arrived = fresh.filter((row) => row.fromAgentId !== agentId || row.toAgentId === agentId);
  const sent = fresh.filter((row) => row.fromAgentId === agentId && row.toAgentId !== agentId);
  const fold = (label: string, rows: TranscriptEntry[]): DwarMessage | null =>
    rows.length === 0 ? null : { role: "user", content: [label, ...rows.map((row) => transcriptText(row, agentId))].join("\n\n") };
  return { turn: fold("[Arrived during this wake]", arrived), sent: fold("[Sent by your process lane]", sent), throughSeq };
}

/**
 * labelEntry gives a transcript row its turn role and `[From:]`/`[To:]`/`[Thought]`/`[Notice from hath]`
 * label from this agent's point of view, stamped with when the row was written (ISO 8601
 * in the box's `TZ` with its offset, `2026-10-02T13:14:48-04:00`) so the agent knows the
 * date and time it is acting at. A report's job status follows the time.
 */
function labelEntry(
  row: TranscriptEntry,
  agentId: string,
): { role: "user" | "assistant"; label: string } {
  const at = row.status === null ? formatISO(row.createdAt) : `${formatISO(row.createdAt)} · ${row.status}`;
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
  return thread.map((row) => ({ role: labelEntry(row, agentId).role, content: transcriptText(row, agentId) }));
}

/** transcriptText is a transcript row as this agent reads it: its label, then its body. */
export function transcriptText(row: TranscriptEntry, agentId: string): string {
  return `${labelEntry(row, agentId).label}\n${entryBody(row)}`;
}

/** A transcript row's text followed by a stub per attachment it carries. */
function entryBody(row: TranscriptEntry): string {
  return [row.content, ...row.attachments.map(attachmentStub)]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * toolsForLane is what a lane may call: the process lane's routing tools, or the
 * work lane's registry plus the embedded tools. A worker gets no `ingest_memory`: it
 * reports what it found to the agent that owns the domain, which stores what matters.
 */
export function toolsForLane(agentId: string, lane: Lane): DwarTool[] {
  if (lane === "router") {
    throw new HathError(500, "internal_error", `agent ${agentId} has no router lane`);
  }
  if (lane === "process") {
    return [
      sendTool,
      steerWorkTool,
      ...embeddedFileReadTools().map(asDwarTool),
      ...(PROCESS_REGISTRY_TOOLS as readonly string[]).map((name) => asDwarTool(findEmbeddedTool(name)!)),
      recallMemoryTool,
      listAgentsTool,
      yieldTool,
    ];
  }
  return [
    ...allTools().map(asDwarTool),
    messageTool,
    listAgentsTool,
    waitTool,
    recallMemoryTool,
    ...(WORKER_ID.test(agentId) ? [] : [ingestMemoryTool]),
    manageAgentTool,
    modifyAgentPromptTool,
    ...embeddedHelperTools().map(asDwarTool),
    ...embeddedFileReadTools().map(asDwarTool),
    ...embeddedFileWriteTools().map(asDwarTool),
    ...embeddedAgentTools().map(asDwarTool),
    ...embeddedSchedulingTools().map(asDwarTool),
    yieldTool,
  ];
}

