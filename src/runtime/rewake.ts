/**
 * The one way news reaches an agent that is not asleep-safe on its own: a helper's report, an
 * async tool's result, a wait that timed out. Each is hath's word to the agent, recorded
 * in its thread from itself to itself, and wakes it whether it is running, idle or asleep. A
 * running agent reads it among its next arrivals; the run queued behind finds nothing new and
 * ends without a model call.
 */

import type { TranscriptEntry } from "./transcript.js";
import { deliverAgentMessage, type DeliverDeps, type NoticeKind } from "./deliver.js";

type RewakeArgs = {
  content: string;
  notice: Extract<NoticeKind, "helper" | "tool" | "wait">;
  /** Why it wakes, for the wake's first line, such as "helper result from task/browser/3". */
  wokenBy: string;
  /** The job the news belongs to (see job-of.ts): a report's is its steer's, a result's the call's, a timeout's the wait's; absent for none. */
  jobId?: string | null;
};

/** rewake records `content` for `agentId` and wakes it. */
export function rewake(deps: DeliverDeps, agentId: string, args: RewakeArgs): Promise<TranscriptEntry> {
  return deliverAgentMessage(deps, {
    fromAgentId: agentId,
    toAgentId: agentId,
    content: args.content,
    notice: args.notice,
    wokenBy: args.wokenBy,
    ...(args.jobId !== undefined ? { jobId: args.jobId } : {}),
  });
}
