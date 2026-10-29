/**
 * Embedded memory tools every work lane holds: `recall_memory` reads Yaad,
 * `ingest_memory` writes it stamped with the calling agent.
 */

import { z } from "zod";
import { yaadToolCall } from "../tools/yaad/call.js";
import { failWithoutAgentIdentity, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import type { DwarTool } from "../types/domain.js";
import { INGEST_MEMORY, RECALL_MEMORY } from "../types/domain.js";

const nodeKind = z.enum(["person", "memory", "plan", "place"]);
const planStatus = z.enum(["idea", "tentative", "confirmed"]);

const recallMemoryInput = z
  .object({
    query: z.string().min(1).optional(),
    from: z.array(z.string().uuid()).min(1).optional(),
    hops: z.number().int().min(0).optional(),
    kind: nodeKind.optional(),
    name: z.string().min(1).optional(),
    occurred_from: z.string().datetime({ offset: true }).optional(),
    occurred_to: z.string().datetime({ offset: true }).optional(),
    status: planStatus.optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

const ingestMemoryInput = z
  .object({
    text: z.string().min(1),
    participant_ids: z.array(z.string().uuid()).optional(),
  })
  .strict();

/** Read memory by meaning, from known nodes, or by exact filters, walking `hops` links out. */
export const recallMemoryTool: DwarTool = {
  name: RECALL_MEMORY,
  description:
    'Look things up in Ankur\'s memory: people, places, plans, events, and facts. Start one of three ways. `query` searches by meaning ("what do I know about Sparsh"). `from` starts at node ids you already have. Filters match exactly: `kind`, `name` (exact title or alias), `occurred_from`/`occurred_to` (a date window, e.g. "what\'s on Tuesday"), `status` (plans). Filters narrow a query; `from` cannot be combined with filters. `hops` walks that many links out from where you started — `{ from: [id], hops: 1 }` is a node and everything linked to it. Returned edges carry their properties. With a query, check `sufficient`: false means memory did not have enough, so say so rather than filling the gap. What memory returns is true: act on it, and do not send a worker to re-check it.',
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Natural-language question to search by meaning" },
      from: {
        type: "array",
        items: { type: "string" },
        description: "Node ids to start from (from an earlier recall_memory result)",
      },
      hops: {
        type: "integer",
        minimum: 0,
        description: "Links to walk out from the start; omit to let a query decide, 0 for just the matches",
      },
      kind: { type: "string", enum: ["person", "memory", "plan", "place"] },
      name: { type: "string", description: "Exact title, or a person's alias" },
      occurred_from: { type: "string", description: "ISO-8601 window start, with offset" },
      occurred_to: { type: "string", description: "ISO-8601 window end, with offset" },
      status: { type: "string", enum: ["idea", "tentative", "confirmed"] },
      limit: { type: "integer", minimum: 1, description: "Max nodes to return" },
    },
  },
};

/** Store a fact, event, deadline, or calendar change (scheduling, a session moved, an outcome); Yaad extracts and reconciles it. */
export const ingestMemoryTool: DwarTool = {
  name: INGEST_MEMORY,
  description:
    "Store something you learned about Ankur's world — a fact, a preference, an event, a scheduled meeting, a deadline, time set aside on his calendar, a change — in memory yourself, as you learn it; no other agent does this for you. Write it in plain language the way you would tell a person. Yaad extracts the people, places, plans, and links and reconciles them with what is already stored, but send only what is new or changed since you last stored it: re-sending a whole report can still duplicate what is there, so recall_memory first when unsure. Keep each call to one topic and a handful of facts. Give every deadline and event its exact date, time, and time zone, and say \"time not stated\" when the source gives none rather than guessing one. To correct something stored earlier, say so outright: \"Correction: <old claim> is wrong; <new claim>.\" A fact you simply leave out is not removed. Do not store progress or status that is about to change — what you checked, what is not posted yet, what is still to do — and label a snapshot you do store (a gradebook) \"as of <date>\". Ankur's calendar is memory too: there are no planner tools. Schedule time for him (a gym session, a study block for an exam, a meal) by saying what, when it starts and ends, and what it is for; a task keeps its deadline when you give it a time (\"Ankur will take the IBM assessment Sat Oct 31, 2:20-3:50 PM; the link still expires Oct 31 at 11:59 PM\"). Change one session the same way, naming the item and its date: moved (\"Thursday's CSE 431 lecture moves to 3:00-4:20 PM\"), cancelled, done, or missed (\"Ankur missed today's gym session\"), plus what it covered or why, which becomes that session's note. Give a place its full street address and the room (\"Engineering Building room 1345, 428 S Shaw Ln, East Lansing, MI 48824\"), and say when Ankur will not attend something so it stays off his planner. Say an outcome on the item it is about (\"Ankur submitted CSE 431 HW3 on Oct 14\"), and never store that something does not exist (\"no quiz this week\"). Do not store how you did a task, how a site, login, tool, or repo behaves, rules for how agents should work (those belong in the owning agent's charter), approvals or relays, or anything about agents and workers: those stay in your transcript and fade. Never store a password, code, or other secret. Pass participant_ids when you already have the people's node ids from recall_memory.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", description: "What to remember, in plain language" },
      participant_ids: {
        type: "array",
        items: { type: "string" },
        description: "Known person node ids to pin the extraction to",
      },
    },
    required: ["text"],
  },
};

/** Run `recall_memory` against Yaad `/recall`. */
export async function runRecallMemory(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  const input = recallMemoryInput.parse(raw);
  return yaadToolCall(
    () => ctx.yaad.recall(input),
    (response) => ({
      nodes: response.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        title: node.title,
        body: node.body,
        occurred_at: node.occurred_at,
        expires_at: node.expires_at,
        detail: node.detail,
        hops: node.hops,
      })),
      edges: response.edges.map((edge) => ({
        src_id: edge.src_id,
        dst_id: edge.dst_id,
        type: edge.type,
        properties: edge.properties,
      })),
      sufficient: response.sufficient,
      coverage: response.coverage,
    }),
  );
}

/** Run `ingest_memory` against Yaad `/ingest`, stamped with the calling agent. */
export async function runIngestMemory(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  const agentId = ctx.callerId;
  if (agentId === null) {
    return failWithoutAgentIdentity();
  }
  const input = ingestMemoryInput.parse(raw);
  return yaadToolCall(
    () =>
      ctx.yaad.ingest({
        text: input.text,
        occurred_at: new Date().toISOString(),
        source: "agent",
        agent_id: agentId,
        ...(input.participant_ids !== undefined ? { participant_ids: input.participant_ids } : {}),
      }),
    (response) => ({
      counts: response.counts,
      operations: response.operations,
    }),
  );
}
