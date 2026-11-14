/**
 * Memory tools: `recall_memory` reads Yaad,
 * `ingest_memory` writes it stamped with the calling agent.
 */

import { z } from "zod";
import { yaadToolCall } from "../tools/yaad/call.js";
import { failWithoutAgentIdentity, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import type { DwarTool } from "../types/domain.js";
import { INGEST_MEMORY, RECALL_MEMORY } from "../types/domain.js";

const nodeKind = z.enum(["person", "memory", "plan", "place", "task"]);
const planStatus = z.enum(["tentative", "confirmed", "cancelled"]);

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
    relevant_on: z.string().date().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

const ingestMemoryInput = z
  .object({
    text: z.string().min(1),
    participant_ids: z.array(z.string().uuid()).optional(),
  })
  .strict();

/**
 * ingest_memory runs in the background (see async.ts): Yaad's ingest took 47 seconds at the
 * median and 11 minutes at worst (370 calls, 2026-10-22 to 29).
 */
export const INGEST_MEMORY_ASYNC = true;

/** Read memory by meaning, from known nodes, or by exact filters (including the tasks relevant on a day), walking `hops` links out. */
export const recallMemoryTool: DwarTool = {
  name: RECALL_MEMORY,
  description:
    'Look things up in Ankur\'s memory: people, places, events (plans), tasks, and facts. Start one of three ways. `query` searches by meaning ("what do I know about Sparsh"). `from` starts at node ids you already have. Filters match exactly: `kind`, `name` (exact title or alias), `occurred_from`/`occurred_to` (an event window: "what\'s on Tuesday" is `kind: "plan"` with that day; a course\'s class sessions are found this way, never by meaning), `status` (events: tentative, confirmed, cancelled), and `relevant_on`. `relevant_on` is a local date (YYYY-MM-DD) and returns every task not done whose window has opened by that day, still open or past due: it is the exact answer to "what is due" or "what is open today", so use it instead of a query for that, with `kind: "task"` or no kind. Each task\'s `detail` has `opens_on`, `closes_at` (when it is due) and `done_at`; a plan\'s has its end, `status`, and `rsvp` (whether Ankur is going). Filters narrow a query; `from` cannot be combined with filters. `hops` walks that many links out from where you started — `{ from: [id], hops: 1 }` is a node and everything linked to it. Returned edges carry their properties. With a query, check `sufficient`: false means memory did not have enough, so say so rather than filling the gap. For when or where something is ("when\'s my advising appt"), name the thing itself ("advising"), or use `kind: "plan"` with a date window; Ankur\'s name adds nothing to a query. Anything Ankur told any agent is in memory: recall before saying you do not know or asking a teammate. A task\'s `detail` has `verified_at` (when it was last created, changed, ticked, or restated true), and `created_at` and `updated_at` sit beside it. A task last verified before today is stale when the answer depends on it: check the source (the course site, the portal, Ankur) and ingest what changed, or restate it as still true if nothing did. Everything else memory returns is true: act on it, and do not send a worker to re-check it.',
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
      kind: { type: "string", enum: ["person", "memory", "plan", "place", "task"] },
      name: { type: "string", description: "Exact title, or a person's alias" },
      occurred_from: { type: "string", description: "ISO-8601 window start, with offset" },
      occurred_to: { type: "string", description: "ISO-8601 window end, with offset" },
      status: { type: "string", enum: ["tentative", "confirmed", "cancelled"], description: "Events only" },
      relevant_on: {
        type: "string",
        description: "Local date YYYY-MM-DD: the tasks not done whose window has opened by then (open or past due)",
      },
      limit: { type: "integer", minimum: 1, description: "Max nodes to return" },
    },
  },
};

/** Store a fact, event, task, or change (a deadline, a class schedule, a session moved, an RSVP, something done); Yaad extracts and reconciles it. */
export const ingestMemoryTool: DwarTool = {
  name: INGEST_MEMORY,
  description:
    "Store something you learned about Ankur's world — a fact, a preference, an event, a deadline, a change — in memory yourself when you learned it first-hand (from Ankur, a page you read, a task you ran). A fact a teammate sends you is already stored by that teammate: do not store it again. Write it in plain language the way you would tell a person. Yaad extracts the people, places, events, tasks, and links and reconciles them with what is already stored, but send only what is new or changed since you last stored it: re-sending a whole report can still duplicate what is there, so recall_memory first when unsure. Keep each call to one topic and a handful of facts. Memory keeps two kinds of dated things. An event has a clock time Ankur is at (an interview, an appointment, an exam at its hour): give its date, start, end, and time zone. A task is something to get done with no time to be at (homework, a form, an application): give when it is due, with the time and zone, and when it becomes relevant, which is its release or open date or the lead the source states (\"posted today\", \"released one week before it is due\", \"start in January\"). Yaad decides each task's window from your text alone and nothing fills one in later, so tell it the dates it needs. Say \"time not stated\" when the source gives none rather than guessing one; a moved deadline keeps its old time unless a new one is given, so say the time it had. A venue is where, never whether. \"(Gradescope)\", \"on D2L\", \"submit via CLion\", \"in person\" say where something is handed in or happens. They never mean it was submitted or done. Say an item was submitted, paid, or done only when Ankur did it or an agent did it for him at his yes, on that item (\"Ankur says he submitted CSE 431 HW3\", \"Ankur's Semgrep application was submitted Nov 13 at his yes\"; add a time only if given). What a page, portal, gradebook or file listing shows (an upload, a `Submitted` badge, a score) is a record an agent can read again, never a done mark. A class that meets on a schedule: give the days, times, building and room, first and last day, and days off, and Yaad stores one session per meeting; change sessions by naming the course and the dates (\"Thursday Nov 19's CSE 380 lecture is cancelled\", \"from Dec 1 CSE 380 meets 10:30-11:50\", \"Ankur missed today's CSE 431 lecture\"). Say whether Ankur is going to something only when he said so (\"Ankur is not going to the talk\"); a declined event stays on his timeline. Say an event is cancelled only when it was called off. Time set aside is stored only when Ankur chose it (\"Ankur will take the IBM assessment Sat Oct 31, 2:20-3:50 PM; the link still expires Oct 31 at 11:59 PM\"); do not lay out his day with meals, study blocks, or routines. To correct something stored earlier, say so outright: \"Correction: <old claim> is wrong; <new claim>.\" A fact you simply leave out is not removed. A task you checked and found unchanged: say it is still true, and Yaad records it as verified today. Do not store progress or status that is about to change — what you checked, what is not posted yet, what is still to do — and label a snapshot you do store (a gradebook) \"as of <date>\"; never store that something does not exist (\"no quiz this week\"), a score on one item, or a submit time on its own. Give a place its full street address and the room (\"Engineering Building room 1345, 428 S Shaw Ln, East Lansing, MI 48824\"). What happened in his world is stored: an application submitted, an offer, a status change, hours entered, each with its date. Do not store how you did a task, how a site, login, tool, or repo behaves, rules for how agents should work (those belong in the owning agent's charter), approvals or relays, or an agent's own working steps and wake progress: those stay in your transcript and fade. Never store a password, code, or other secret. Pass participant_ids when you already have the people's node ids from recall_memory.",
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
        created_at: node.created_at,
        updated_at: node.updated_at,
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
