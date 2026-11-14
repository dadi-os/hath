/**
 * Pickups: hath's word to Ankur that an agent has his job, sent for the agent when the job is
 * taking a while (`runtime.hath_pickups`). A lane cannot know how long a job will take when it
 * starts it, so a pickup the model sent up front went out on jobs answered seconds later; hath
 * sends one only once the answer is overdue, with no model call.
 */

import { sql } from "drizzle-orm";
import { agentLogs, agents, messages } from "../db/schema.js";
import { deliverAgentMessage, type DeliverDeps } from "./deliver.js";

/** A message older than this gets no pickup: it is past the point where one helps, as after a long restart. */
const PICKUP_HORIZON_MS = 15 * 60_000;

/** What a pickup says. */
export const PICKUP_TEXT = "Working on it.";

/**
 * sendPickups sends PICKUP_TEXT to Ankur, as the agent with status running, for each active
 * agent whose latest message from him is between `afterMs` (`runtime.pickup_delay_s`) and PICKUP_HORIZON_MS old
 * at `now`, whose work lane has taken a step since it (so it is a job being worked, not a
 * message that needed none), and that has sent him nothing since it. The pickup is itself
 * a message to him after his, so each of his messages gets one at most. Returns how many it sent.
 */
export async function sendPickups(deps: DeliverDeps, now: Date, afterMs: number): Promise<number> {
  const due = await deps.db.execute<{ agent_id: string }>(sql`
    select m.to_agent_id as agent_id
    from ${messages} m
    join ${agents} a on a.id = m.to_agent_id and a.active
    where m.from_agent_id is null and m.to_agent_id is not null and m.kind = 'message'
      and m.created_at <= ${new Date(now.getTime() - afterMs).toISOString()}::timestamptz
      and m.created_at > ${new Date(now.getTime() - PICKUP_HORIZON_MS).toISOString()}::timestamptz
      and not exists (
        select 1 from ${messages} later
        where later.from_agent_id is null and later.to_agent_id = m.to_agent_id and later.kind = 'message' and later.seq > m.seq
      )
      and not exists (
        select 1 from ${messages} back
        where back.from_agent_id = m.to_agent_id and back.to_agent_id is null and back.seq > m.seq
      )
      and exists (
        select 1 from ${agentLogs} l
        where l.agent_id = m.to_agent_id and l.lane = 'work' and l.event = 'response' and l.created_at > m.created_at
      )
  `);
  for (const { agent_id: agentId } of due) {
    await deliverAgentMessage(deps, { fromAgentId: agentId, toAgentId: null, content: PICKUP_TEXT, status: "running", sentBy: "hath" });
  }
  return due.length;
}
