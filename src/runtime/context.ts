import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatISO } from "date-fns";
import { asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentTools, agents, tools } from "../db/schema.js";
import { HathError } from "../errors.js";
import type { DwarChatRequest, DwarMessage, DwarTool, Lane } from "../types/domain.js";
import {
  CREATE_ATTACHMENT,
  DISPATCH_MESSAGE,
  FORWARD_ATTACHMENT,
  INGEST_MEMORY,
  LIST_AGENTS,
  MANAGE_AGENT,
  MODIFY_AGENT_PROMPT,
  READ_ATTACHMENT,
  RECALL_MEMORY,
  SEND_MESSAGE,
  STEER_REASONING,
  WAIT,
  YIELD,
} from "../types/domain.js";
import {
  attachmentStub,
  createAttachmentTool,
  forwardAttachmentTool,
  readAttachmentTool,
} from "./attachments.js";
import {
  dispatchMessageTool,
  listAgentsTool,
  sendMessageTool,
  steerReasoningTool,
  waitTool,
  yieldTool,
} from "./tools.js";
import { ingestMemoryTool, recallMemoryTool } from "./memory.js";
import { manageAgentTool, modifyAgentPromptTool } from "./modify.js";
import type { TranscriptEntry, TranscriptStore } from "./transcript.js";
import { embeddedAgentTools, embeddedSchedulingTools } from "../tools/registry.js";
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

/** An assembled lane request plus the newest transcript seq it includes (0 when empty). */
export type AssembledContext = Omit<DwarChatRequest, "tool_choice"> & { throughSeq: number };

/**
 * hath's system for an identity, in order: the system doctrine
 * (`prompts/system.md`, shared by everyone), the charter (an agent's stored
 * prompt, or `prompts/router.md` for the router), lineage facts, then active
 * direct children — for the router, the active root agents.
 */
async function composeSystem(
  db: Db,
  serviceRoot: string,
  /** Null is the router. */
  agentId: string | null,
): Promise<string> {
  let charter: string;
  let parentAgentId: string | null = null;
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
  }

  const childRows = await db
    .select({
      id: agents.id,
      active: agents.active,
      systemPrompt: agents.systemPrompt,
    })
    .from(agents)
    .where(agentId === null ? isNull(agents.parentAgentId) : eq(agents.parentAgentId, agentId))
    .orderBy(asc(agents.id));
  const activeChildren = childRows.filter((c) => c.active);

  let system = [
    loadPrompt(serviceRoot, "system.md"),
    charter,
    lineageBlock(agentId, parentAgentId),
  ].join("\n\n");
  if (activeChildren.length > 0) {
    const lines = activeChildren.map((c) => {
      const purpose = c.systemPrompt.trim().replace(/\n[\s\S]*$/, "");
      const brief = purpose.length > 120 ? `${purpose.slice(0, 117)}…` : purpose;
      return brief ? `- ${c.id}: ${brief}` : `- ${c.id}`;
    });
    system = `${system}\n\nYour active direct children:\n${lines.join("\n")}`;
  }
  return system;
}

/**
 * An agent lane's request: its system, then its message history. History keeps
 * at least the last `transcriptWindowMessages` turns; its start only advances
 * in steps of `transcriptWindowStep` so the provider's cached prefix survives
 * new messages. Dwar appends lane doctrine as a cached block.
 */
export async function assembleContext(opts: {
  db: Db;
  agentId: string;
  lane: Lane;
  transcript: TranscriptStore;
  serviceRoot: string;
  transcriptWindowMessages: number;
  transcriptWindowStep: number;
}): Promise<AssembledContext> {
  const system = await composeSystem(opts.db, opts.serviceRoot, opts.agentId);
  const entries = opts.transcript.transcriptFor(opts.agentId);
  const overflow = entries.length - opts.transcriptWindowMessages;
  const start =
    overflow > 0 ? Math.floor(overflow / opts.transcriptWindowStep) * opts.transcriptWindowStep : 0;
  const dwarMessages: DwarMessage[] = entries.slice(start).map((row) => {
    const labelled = labelEntry(row, opts.agentId);
    return { role: labelled.role, content: `${labelled.label}\n${entryBody(row)}` };
  });

  return {
    system,
    messages: dwarMessages,
    tools: await toolsForLane(opts.db, opts.agentId, opts.lane),
    throughSeq: entries.at(-1)?.seq ?? 0,
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
    messages: [{ role: "user", content: `[From: Ankur · ${formatISO(new Date())}]\n${opts.utterance}` }],
    tools: routerLaneTools(),
    throughSeq: 0,
  };
}

/**
 * arrivalsSince folds transcript entries newer than `afterSeq` into one user
 * turn, so messages that land mid-wake join the scratchpad at the point they
 * arrived instead of rewriting the history above it. `turn` is null when
 * nothing arrived; `throughSeq` is the newest seq seen.
 */
export function arrivalsSince(
  transcript: TranscriptStore,
  agentId: string,
  afterSeq: number,
): { turn: DwarMessage | null; throughSeq: number } {
  const fresh = transcript.transcriptFor(agentId).filter((row) => row.seq > afterSeq);
  if (fresh.length === 0) {
    return { turn: null, throughSeq: afterSeq };
  }
  const lines = fresh.map((row) => `${labelEntry(row, agentId).label}\n${entryBody(row)}`);
  return {
    turn: { role: "user", content: `[Arrived during this wake]\n\n${lines.join("\n\n")}` },
    throughSeq: fresh.at(-1)!.seq,
  };
}

/**
 * labelEntry gives a transcript row its turn role and `[From:]`/`[To:]`/`[Thought]`
 * label from this agent's point of view, stamped with when the row was written (ISO 8601
 * in the box's `TZ` with its offset, `2026-10-02T13:14:48-04:00`) so the agent knows the
 * date and time it is acting at.
 */
function labelEntry(
  row: TranscriptEntry,
  agentId: string,
): { role: "user" | "assistant"; label: string } {
  const at = formatISO(row.createdAt);
  if (row.fromAgentId === agentId && row.toAgentId === agentId) {
    return { role: "assistant", label: `[Thought · ${at}]` };
  }
  if (row.toAgentId === agentId) {
    return { role: "user", label: `[From: ${row.fromAgentId === null ? "Ankur" : row.fromAgentId} · ${at}]` };
  }
  return { role: "assistant", label: `[To: ${row.toAgentId === null ? "Ankur" : row.toAgentId} · ${at}]` };
}

/** A transcript row's text followed by a stub per attachment it carries. */
function entryBody(row: TranscriptEntry): string {
  return [row.content, ...row.attachments.map(attachmentStub)]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

async function toolsForLane(db: Db, agentId: string, lane: Lane): Promise<DwarTool[]> {
  if (lane === "router") {
    throw new HathError(500, "internal_error", `agent ${agentId} has no router lane`);
  }
  if (lane === "conversation") {
    return [
      dispatchMessageTool,
      forwardAttachmentTool,
      readAttachmentTool,
      steerReasoningTool,
      listAgentsTool,
      yieldTool,
    ];
  }
  const grants = await db
    .select({
      name: tools.name,
      description: tools.description,
      inputSchema: tools.inputSchema,
      usage: agentTools.usage,
    })
    .from(agentTools)
    .innerJoin(tools, eq(agentTools.toolId, tools.id))
    .where(eq(agentTools.agentId, agentId))
    .orderBy(asc(tools.name));
  const granted: DwarTool[] = grants.map((grant) => ({
    name: grant.name,
    description: `${grant.description}\n\n${grant.usage}`,
    input_schema: grant.inputSchema,
  }));
  return [
    ...granted,
    sendMessageTool,
    readAttachmentTool,
    createAttachmentTool,
    listAgentsTool,
    waitTool,
    recallMemoryTool,
    ingestMemoryTool,
    manageAgentTool,
    modifyAgentPromptTool,
    ...embeddedAgentTools().map(asDwarTool),
    ...embeddedSchedulingTools().map(asDwarTool),
    yieldTool,
  ];
}

export const embeddedReasoningTools = [
  SEND_MESSAGE,
  READ_ATTACHMENT,
  CREATE_ATTACHMENT,
  LIST_AGENTS,
  WAIT,
  RECALL_MEMORY,
  INGEST_MEMORY,
  MANAGE_AGENT,
  MODIFY_AGENT_PROMPT,
  ...embeddedAgentTools().map((tool) => tool.name),
  ...embeddedSchedulingTools().map((tool) => tool.name),
  YIELD,
];
export const embeddedConversationTools = [
  DISPATCH_MESSAGE,
  FORWARD_ATTACHMENT,
  READ_ATTACHMENT,
  STEER_REASONING,
  LIST_AGENTS,
  YIELD,
] as const;
