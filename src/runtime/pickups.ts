/**
 * Pickups: hath's word to Ankur that an agent has his job, sent for the agent when the job is
 * taking a while. An agent cannot know how long a job will take when it starts it, so a pickup
 * the model sent up front went out on jobs answered seconds later; hath sends one only once the
 * answer is overdue, with no model call.
 */

import { sql } from "drizzle-orm";
import { agentLogs, agents, jobs, messages } from "../db/schema.js";
import { deliverAgentMessage, type DeliverDeps } from "./deliver.js";

/** A message older than this gets no pickup: it is past the point where one helps, as after a long restart. */
const PICKUP_HORIZON_MS = 15 * 60_000;

/** What a pickup says. */
export const PICKUP_TEXT = "Working on it.";

/**
 * sendPickups sends PICKUP_TEXT to Ankur, as the agent, for each open job of his whose opening
 * newest message from him is between `afterMs` (`runtime.pickup_delay_s`) and PICKUP_HORIZON_MS
 * old at `now`, whose agent has taken a step in the job (so it is a job being worked, not a
 * message that needed none), is live (`live`: running now or waiting on something pending, so an
 * agent that only yielded has nothing in hand to report on) and has sent him nothing since that
 * message. A message that joins an open job restarts the clock. The pickup is itself a message in
 * the job, so each of his messages gets one at most. Returns how many it sent.
 */
export async function sendPickups(
  deps: DeliverDeps,
  now: Date,
  afterMs: number,
  live: (agentId: string) => Promise<boolean>,
): Promise<number> {
  const due = await deps.db.execute<{ agent_id: string; job_id: string }>(sql`
    select j.agent_id, j.id as job_id
    from ${jobs} j
    join ${agents} a on a.id = j.agent_id and a.active
    join lateral (
      select ask.seq, ask.created_at
      from ${messages} ask
      where ask.job_id = j.id and ask.from_agent_id is null and ask.to_agent_id = j.agent_id
      order by ask.seq desc
      limit 1
    ) newest on true
    where j.requester_id is null and j.state = 'open'
      and newest.created_at <= ${new Date(now.getTime() - afterMs).toISOString()}::timestamptz
      and newest.created_at > ${new Date(now.getTime() - PICKUP_HORIZON_MS).toISOString()}::timestamptz
      and not exists (
        select 1 from ${messages} back
        where back.job_id = j.id and back.from_agent_id = j.agent_id and back.to_agent_id is null
          and back.seq > newest.seq
      )
      and exists (
        select 1 from ${agentLogs} l
        where l.job_id = j.id and l.event = 'response'
      )
  `);
  let sent = 0;
  for (const { agent_id: agentId, job_id: jobId } of due) {
    if (!(await live(agentId))) {
      continue;
    }
    await deliverAgentMessage(deps, { fromAgentId: agentId, toAgentId: null, content: PICKUP_TEXT, sentBy: "hath", jobId });
    sent += 1;
  }
  return sent;
}
