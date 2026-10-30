/**
 * What an agent's work lane is waiting on (the `wait` tool). A watch is a row, so a restart
 * keeps it: the scheduler's tick wakes the lane with facts when one falls due, and the
 * awaited result or message wakes it on its own (deliver.ts takes the watch then). A watch
 * is dropped when the lane next runs, since a lane that woke for any reason is not waiting.
 */

import { and, desc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { agentLogs, agents, messages, watches, type WatchRow } from "../db/schema.js";
import type { NasClient } from "../nas/client.js";
import { parseTaskAddress } from "../tools/helper/tasks.js";
import { fail, failWithoutAgentIdentity, ok, type ToolContext, type ToolExecResult } from "../tools/shared.js";
import type { DwarTool } from "../types/domain.js";
import { WAIT } from "../types/domain.js";
import { agentIdSchema } from "../agent-id.js";
import type { DeliverDeps } from "./deliver.js";
import { rewakeWork } from "./rewake.js";

/** Longest a wait may last: a day, since Nas forgets an idle task after that. */
export const WAIT_MAX_MINUTES = 24 * 60;

const waitInput = z
  .object({
    on: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(10)]),
    timeout_minutes: z.number().int().min(1).max(WAIT_MAX_MINUTES),
  })
  .strict();

/** The wait tool the work lane sees. */
export const waitTool: DwarTool = {
  name: WAIT,
  description: `End this run and sleep until what you are waiting on arrives: a helper task's result (its id, such as task/browser/3, from steer_browser or steer_terminal), a message from another agent (its agent id), or a list of either. No model call runs while you wait; the result or message wakes you by itself, and you are shown as waiting on it. If nothing comes within timeout_minutes (1 to ${WAIT_MAX_MINUTES}) you are woken with the facts: for a task its state and how long since it last did anything, for an agent how long since it last acted and whether it has run since you messaged it. Call it after you have done everything you can in this run; to end with nothing to wait on, call yield.`,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["on", "timeout_minutes"],
    properties: {
      on: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
        ],
        description: "A task id, an agent id, or a list of them",
      },
      timeout_minutes: {
        type: "integer",
        minimum: 1,
        maximum: WAIT_MAX_MINUTES,
        description: "Minutes to wait before you are woken with what is known",
      },
    },
  },
};

/** The agent's watch, if it has one. */
export async function watchOf(db: Db, agentId: string): Promise<WatchRow | undefined> {
  const [row] = await db.select().from(watches).where(eq(watches.agentId, agentId));
  return row;
}

/** clearWatch drops the agent's watch. */
export async function clearWatch(db: Db, agentId: string): Promise<void> {
  await db.delete(watches).where(eq(watches.agentId, agentId));
}

/**
 * takeWatch drops the agent's watch when it is waiting on `target` (a task address or an
 * agent id), and says whether it was: that arrival is what the lane waited for.
 */
export async function takeWatch(db: Db, agentId: string, target: string): Promise<boolean> {
  const taken = await db
    .delete(watches)
    .where(and(eq(watches.agentId, agentId), sql`${target} = any(${watches.targets})`))
    .returning({ agentId: watches.agentId });
  return taken.length > 0;
}

/**
 * runWait records what the caller waits on, after checking that every target exists, and
 * returns the result the lane loop ends the run on (see step.ts).
 */
export async function runWait(ctx: ToolContext, raw: unknown): Promise<ToolExecResult> {
  if (ctx.callerId === null) {
    return failWithoutAgentIdentity();
  }
  const input = waitInput.parse(raw);
  const targets = [...new Set(Array.isArray(input.on) ? input.on : [input.on])];
  for (const target of targets) {
    const problem = await targetProblem(ctx, target);
    if (problem !== null) {
      return fail(problem);
    }
  }
  const dueAt = new Date(Date.now() + input.timeout_minutes * 60_000);
  await ctx.db
    .insert(watches)
    .values({ agentId: ctx.callerId, targets, dueAt })
    .onConflictDoUpdate({ target: watches.agentId, set: { targets, since: new Date(), dueAt } });
  return ok({ waiting_on: targets, wakes_by: dueAt.toISOString() });
}

/** targetProblem is why `target` cannot be waited on, or null when it can. */
async function targetProblem(ctx: ToolContext, target: string): Promise<string | null> {
  if (target.startsWith("task/")) {
    const address = parseTaskAddress(target);
    if (address === null) {
      return `${target} is not a task id; they look like task/browser/3`;
    }
    await ctx.nas.getTask(address.kind, address.id);
    return null;
  }
  if (!agentIdSchema.safeParse(target).success) {
    return `${target} is neither a task id (task/browser/3) nor an agent id`;
  }
  const [agent] = await ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.id, target));
  return agent === undefined ? `no agent ${target}` : null;
}

/** What the facts of a due watch need: the database, Nas for task state, and a way to wake the lane. */
export type WatchDeps = {
  deliver: DeliverDeps;
  nas: NasClient;
};

/**
 * checkDueWatches wakes the work lane of every agent whose watch has fallen due, with the
 * facts of what it waited on, and drops the watch. Run from the scheduler's tick.
 */
export async function checkDueWatches(deps: WatchDeps, now = new Date()): Promise<void> {
  const due = await deps.deliver.db.select().from(watches).where(lte(watches.dueAt, now));
  for (const watch of due) {
    const facts = await Promise.all(watch.targets.map((target) => factsAbout(deps, watch, target, now)));
    await clearWatch(deps.deliver.db, watch.agentId);
    await rewakeWork(deps.deliver, watch.agentId, {
      content: `Your wait timed out after ${minutesBetween(watch.since, now)} minutes with nothing from what you waited on.\n${facts.map((fact) => `- ${fact}`).join("\n")}`,
      notice: "wait",
      wokenBy: "wait timeout",
    });
  }
}

/** factsAbout is what is known of one thing a lane waited on. */
async function factsAbout(deps: WatchDeps, watch: WatchRow, target: string, now: Date): Promise<string> {
  const address = parseTaskAddress(target);
  if (address !== null) {
    try {
      const task = await deps.nas.getTask(address.kind, address.id);
      return `${target} is ${task.status}; it last did anything ${minutesBetween(new Date(task.last_activity), now)} minutes ago.`;
    } catch (err) {
      return `${target} could not be read: ${err instanceof Error ? err.message : String(err)}.`;
    }
  }
  const db = deps.deliver.db;
  const [lastLog] = await db
    .select({ at: agentLogs.createdAt })
    .from(agentLogs)
    .where(eq(agentLogs.agentId, target))
    .orderBy(desc(agentLogs.createdAt))
    .limit(1);
  const [lastMessage] = await db
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.fromAgentId, watch.agentId), eq(messages.toAgentId, target)))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const active = lastLog === undefined ? "it has never acted" : `it last acted ${minutesBetween(lastLog.at, now)} minutes ago`;
  if (lastMessage === undefined) {
    return `${target}: ${active}; you have not messaged it.`;
  }
  const ran = lastLog !== undefined && lastLog.at > lastMessage.at;
  return `${target}: ${active}; ${ran ? "it has run since" : "it has not run since"} you messaged it ${minutesBetween(lastMessage.at, now)} minutes ago.`;
}

/** Whole minutes from `from` to `to`. */
function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}
