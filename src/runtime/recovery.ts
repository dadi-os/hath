/**
 * Boot recovery for wakes a Hath restart cut short. Run state (wakes, locks, interrupts) lives
 * in memory, so a deploy, reboot or crash ends every running wake without a word. The audit log
 * still shows it: since the agent's last runtime report, an agent whose last step is not a yield,
 * or a message that no step followed, belongs to a wake that never finished.
 *
 * An agent that had only received a message — no step had started — is simply woken to handle
 * it. Anything further along is never replayed: a click or submit may already have happened, so
 * hath sends a notice to the agent's current requester (whoever it is working for, Ankur
 * included), naming its last step. The notice does not wake the requester, and it is sent only
 * when the wake's last step falls inside `[runtime].recovery_window_minutes` of boot: a wake
 * that died long before the restart is stale, and reporting it would restart work nobody is
 * waiting on. Notices never count as messages waiting to be handled, so one boot's notices do
 * not wake anyone on the next, and an agent's notice from its own helper is not a runtime
 * report: its wake may still be running.
 */

import { randomUUID } from "node:crypto";
import { formatISO } from "date-fns";
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { currentRequester } from "../db/messages.js";
import { agentLogs } from "../db/schema.js";
import { closeInterruptedWakes, insertWake } from "../db/wakes.js";
import type { DwarResponseBlock, WakeOrigin } from "../types/domain.js";
import {
  deliverAgentMessage,
  type DeliverDeps,
} from "./deliver.js";
import type { RuntimeLog } from "./engine.js";

/** Why a wake the restart cut short ended, as its row records it. */
const RESTART_ERROR = "interrupted by a hath restart";

/** What a wake started or reported by boot recovery is recorded as. */
const RECOVERY_ORIGIN: WakeOrigin = { kind: "recovery", ref: null, openedByMessageId: null };

/** One active agent whose audit log shows a wake that never finished. */
type InterruptedWake = {
  agent_id: string;
  /** The agent's last step was not a yield or a stop. */
  cut: boolean;
  /** A message arrived after the agent's last model call. */
  unhandled: boolean;
  /** The newest audit row since the agent's last notice. */
  last_at: Date;
};

/**
 * findInterruptedWakes reads, for every active agent, its audit rows since its
 * last runtime report and returns the agents whose wake never finished.
 */
async function findInterruptedWakes(db: Db): Promise<InterruptedWake[]> {
  const rows = await db.execute<InterruptedWake>(sql`
    with reported as (
      select from_agent_id as agent_id, max(created_at) as at
      from messages
      where kind = 'notice' and from_agent_id is not null and to_agent_id is distinct from from_agent_id
      group by from_agent_id
    ),
    recent as (
      select l.*
      from agent_logs l
      join agents a on a.id = l.agent_id and a.active
      left join reported r on r.agent_id = l.agent_id
      where r.at is null or l.created_at > r.at
    ),
    touches as (
      select from_agent_id as agent_id, created_at, false as received
      from messages
      where from_agent_id is not null and kind <> 'utterance'
      union all
      select to_agent_id, created_at, kind = 'message'
      from messages
      where to_agent_id is not null and kind <> 'utterance'
    ),
    recent_touches as (
      select t.*
      from touches t
      join agents a on a.id = t.agent_id and a.active
      left join reported r on r.agent_id = t.agent_id
      where r.at is null or t.created_at > r.at
    ),
    touch_summary as (
      select
        agent_id,
        max(created_at) as last_at,
        max(created_at) filter (where received) as received_at
      from recent_touches
      group by agent_id
    ),
    log_summary as (
      select
        agent_id,
        max(created_at) as last_at,
        max(created_at) filter (where event = 'response') as responded_at,
        max(created_at) filter (
          where event = 'tool_result'
            and (payload->>'name' = 'yield' or payload->>'terminated' = 'true')
        ) as end_at
      from recent
      group by agent_id
    ),
    summary as (
      select
        coalesce(l.agent_id, t.agent_id) as agent_id,
        greatest(l.last_at, t.last_at) as last_at,
        t.received_at,
        l.responded_at,
        l.last_at as step_at,
        l.end_at
      from log_summary l
      full join touch_summary t on t.agent_id = l.agent_id
    ),
    flags as (
      select
        agent_id,
        last_at,
        coalesce(step_at > coalesce(end_at, '-infinity'), false) as cut,
        coalesce(received_at > coalesce(responded_at, '-infinity'), false) as unhandled
      from summary
    )
    select * from flags
    where cut or unhandled
    order by agent_id
  `);
  return [...rows];
}

/**
 * lastStep describes where the agent stopped: a tool it had started
 * whose result was never recorded, or the last tool that did finish.
 */
async function lastStep(db: Db, agentId: string): Promise<string> {
  const [last] = await db
    .select({ event: agentLogs.event, payload: agentLogs.payload, createdAt: agentLogs.createdAt })
    .from(agentLogs)
    .where(eq(agentLogs.agentId, agentId))
    .orderBy(desc(agentLogs.createdAt))
    .limit(1);
  if (!last) {
    throw new Error(`agent ${agentId} has no log rows to describe`);
  }
  const at = formatISO(last.createdAt);
  if (last.event === "tool_result") {
    return `Its last finished step was ${String(last.payload.name)} at ${at}.`;
  }
  const started = (last.payload.content as DwarResponseBlock[])
    .filter((block) => block.type === "tool_use")
    .map((block) => block.name);
  if (started.length === 0) {
    return `It was mid-thought at ${at}.`;
  }
  return `It had started ${started.join(", ")} at ${at} and no result was recorded, so that may or may not have run.`;
}

/**
 * recoverInterruptedWakes runs once at boot, before anything else wakes an
 * agent: it wakes agents that only had a message waiting and has every agent
 * caught mid-wake report to its current requester. Wakes the restart left open are
 * closed with an error first, and each report gets a `recovery` wake row carrying what
 * was cut.
 */
export async function recoverInterruptedWakes(
  deps: DeliverDeps & { log: RuntimeLog; recoveryWindowMinutes: number },
): Promise<void> {
  const closed = await closeInterruptedWakes(deps.db, RESTART_ERROR);
  deps.log.info({ code: "wakes_closed", wakes: closed }, "closed the wakes a restart left open");
  const cutoff = Date.now() - deps.recoveryWindowMinutes * 60_000;
  for (const wake of await findInterruptedWakes(deps.db)) {
    if (!wake.cut) {
      deps.log.info({ code: "wake_resumed", agent_id: wake.agent_id }, "restart left a message unhandled; waking the agent");
      deps.enqueue(wake.agent_id, undefined, RECOVERY_ORIGIN);
      continue;
    }
    if (new Date(wake.last_at).getTime() < cutoff) {
      deps.log.info(
        { code: "wake_stale", agent_id: wake.agent_id, last_at: wake.last_at },
        "restart found a wake that stopped long before it; not reporting it",
      );
      continue;
    }
    const details: string[] = [];
    if (wake.cut) {
      details.push(await lastStep(deps.db, wake.agent_id));
    }
    if (wake.unhandled) {
      details.push("A message it received was never handled.");
    }
    const now = new Date();
    await insertWake(deps.db, {
      id: randomUUID(),
      agentId: wake.agent_id,
      origin: RECOVERY_ORIGIN,
      startedAt: now,
      endedAt: now,
      error: details.join(" "),
    });
    const requester = await currentRequester(deps.db, wake.agent_id);
    deps.log.warn(
      { code: "wake_interrupted", agent_id: wake.agent_id, report_to: requester },
      "restart cut a wake short",
    );
    if (requester === null) {
      continue;
    }
    await deliverAgentMessage(deps, {
      fromAgentId: wake.agent_id,
      toAgentId: requester,
      content: `Hath restarted while ${wake.agent_id} was working, so it stopped before finishing. ${details.join(" ")} Work after its last update was not done. If you still need it, message ${wake.agent_id}; it checks its logs before redoing anything. Otherwise nothing is needed.`,
      notice: "wake_interrupted",
      wake: false,
    });
  }
}
