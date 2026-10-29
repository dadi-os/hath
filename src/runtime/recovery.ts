/**
 * Boot recovery for wakes a Hath restart cut short. Lane state (wakes, locks,
 * steers, send_message hand-offs) lives in memory, so a deploy, reboot or crash
 * ends every running wake without a word. The audit log still shows it: since
 * the agent's last runtime report, a lane whose last step is not a yield, or a
 * message, steer or hand-off that no lane step followed, belongs to a wake that
 * never finished.
 *
 * An agent that had only received a message — no lane step had started — is
 * simply woken to handle it. Anything further along is never replayed: a click
 * or submit may already have happened, so hath sends a notice to the agent's
 * current requester (whoever it is working for, Ankur included), naming its last
 * step. The notice does not wake the requester, and it is sent only when the wake's
 * last step falls inside `[runtime].recovery_window_minutes` of boot: a wake
 * that died long before the restart is stale, and reporting it would restart
 * work nobody is waiting on. Notices never count as messages waiting to be
 * handled, so one boot's notices do not wake anyone on the next.
 */

import { formatISO } from "date-fns";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentsWithPendingHandoffs } from "../db/handoffs.js";
import { currentRequester } from "../db/messages.js";
import { agentLogs } from "../db/schema.js";
import type { DwarResponseBlock } from "../types/domain.js";
import {
  deliverAgentMessage,
  type DeliverDeps,
} from "./deliver.js";
import type { RuntimeLog } from "./engine.js";

/** One active agent whose audit log shows a wake that never finished. */
type InterruptedWake = {
  agent_id: string;
  /** The work lane's last step was not a yield or a terminate. */
  work_cut: boolean;
  /** The process lane's last step was not a yield. */
  process_cut: boolean;
  /** A steer was queued after the work lane's last step. */
  steer_lost: boolean;
  /** A send_message hand-off (from before the work lane sent its own messages) was queued after the process lane's last turn. */
  hand_off_lost: boolean;
  /** A message arrived after the process lane's last turn. */
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
      select agent_id, max(created_at) as at
      from agent_logs
      where event = 'message' and payload->>'direction' = 'send' and payload->>'kind' = 'notice'
      group by agent_id
    ),
    recent as (
      select l.*
      from agent_logs l
      join agents a on a.id = l.agent_id and a.active
      left join reported r on r.agent_id = l.agent_id
      where r.at is null or l.created_at > r.at
    ),
    summary as (
      select
        agent_id,
        max(created_at) as last_at,
        max(created_at) filter (
          where event = 'message' and payload->>'direction' = 'receive' and payload->>'kind' is distinct from 'notice'
        ) as received_at,
        max(created_at) filter (where lane = 'process' and event = 'response') as conversed_at,
        max(created_at) filter (where lane = 'process' and event in ('response', 'tool_result')) as process_at,
        max(created_at) filter (where lane = 'process' and event = 'tool_result' and payload->>'name' = 'yield') as process_yield_at,
        max(created_at) filter (where lane = 'work') as work_at,
        max(created_at) filter (
          where lane = 'work' and event = 'tool_result'
            and (payload->>'name' = 'yield' or payload->>'terminated' = 'true')
        ) as work_end_at,
        max(created_at) filter (
          where lane = 'process' and event = 'tool_result' and payload->>'name' = 'steer_work'
            and payload->>'is_error' = 'false' and payload->>'content' not like '%"terminate":true%'
        ) as steered_at,
        max(created_at) filter (
          where lane = 'work' and event = 'tool_result' and payload->>'name' = 'send_message'
            and payload->>'is_error' = 'false' and payload->>'content' like '%"handed_off":true%'
        ) as handed_off_at
      from recent
      group by agent_id
    ),
    flags as (
      select
        agent_id,
        last_at,
        coalesce(work_at > coalesce(work_end_at, '-infinity'), false) as work_cut,
        coalesce(process_at > coalesce(process_yield_at, '-infinity'), false) as process_cut,
        coalesce(steered_at > coalesce(work_at, '-infinity'), false) as steer_lost,
        coalesce(handed_off_at > coalesce(conversed_at, '-infinity'), false) as hand_off_lost,
        coalesce(received_at > coalesce(conversed_at, '-infinity'), false) as unhandled
      from summary
    )
    select * from flags
    where work_cut or process_cut or steer_lost or hand_off_lost or unhandled
    order by agent_id
  `);
  return [...rows];
}

/**
 * lastWorkStep describes where the work lane stopped: a tool it had started
 * whose result was never recorded, or the last tool that did finish.
 */
async function lastWorkStep(db: Db, agentId: string): Promise<string> {
  const [last] = await db
    .select({ event: agentLogs.event, payload: agentLogs.payload, createdAt: agentLogs.createdAt })
    .from(agentLogs)
    .where(and(eq(agentLogs.agentId, agentId), eq(agentLogs.lane, "work")))
    .orderBy(desc(agentLogs.createdAt))
    .limit(1);
  if (!last) {
    throw new Error(`agent ${agentId} has no work-lane rows to describe`);
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
 * caught mid-wake report to its current requester.
 */
export async function recoverInterruptedWakes(
  deps: DeliverDeps & { log: RuntimeLog; recoveryWindowMinutes: number },
): Promise<void> {
  for (const agentId of await agentsWithPendingHandoffs(deps.db)) {
    deps.log.info({ code: "handoffs_resumed", agent_id: agentId }, "restart left hand-offs unsent; waking the agent's process lane");
    deps.enqueueProcess(agentId);
  }
  const cutoff = Date.now() - deps.recoveryWindowMinutes * 60_000;
  for (const wake of await findInterruptedWakes(deps.db)) {
    const midFlight = wake.work_cut || wake.process_cut || wake.steer_lost || wake.hand_off_lost;
    if (!midFlight) {
      deps.log.info({ code: "wake_resumed", agent_id: wake.agent_id }, "restart left a message unhandled; waking the agent");
      deps.enqueueProcess(wake.agent_id);
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
    if (wake.work_cut) {
      details.push(await lastWorkStep(deps.db, wake.agent_id));
    }
    if (wake.process_cut) {
      details.push("It was mid-reply.");
    }
    if (wake.steer_lost) {
      details.push("An instruction it had queued for itself was never picked up.");
    }
    if (wake.hand_off_lost) {
      details.push("A message it had written was never sent.");
    }
    if (wake.unhandled) {
      details.push("A message it received was never handled.");
    }
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
