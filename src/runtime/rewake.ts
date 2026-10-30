/**
 * The one way news reaches an agent that is not asleep-safe on its own: a helper's report, an
 * async tool's result, a wait that timed out. Each is hath's word to the agent, recorded
 * in its thread from itself to itself, and wakes its work lane whether that lane is running,
 * idle or asleep. A running lane reads it among its next arrivals; the run queued behind
 * finds nothing new and ends without a model call.
 */

import type { TranscriptEntry } from "./transcript.js";
import { deliverAgentMessage, type DeliverDeps, type NoticeKind } from "./deliver.js";

/** rewakeWork records `content` for `agentId`, with `attachmentIds` as its files, and wakes its work lane. */
export async function rewakeWork(
  deps: DeliverDeps,
  agentId: string,
  args: {
    content: string;
    notice: Extract<NoticeKind, "helper" | "tool" | "wait">;
    /** Why it wakes, for the wake's first line, such as "helper result from task/browser/3". */
    wokenBy: string;
    attachmentIds?: string[];
  },
): Promise<TranscriptEntry> {
  return deliverAgentMessage(deps, {
    fromAgentId: agentId,
    toAgentId: agentId,
    content: args.content,
    attachmentIds: args.attachmentIds ?? [],
    notice: args.notice,
    wakeWork: true,
    wokenBy: args.wokenBy,
    lane: "work",
  });
}
