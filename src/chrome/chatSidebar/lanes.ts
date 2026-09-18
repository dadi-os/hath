/** Pure helpers for chat sidebar lane/message presentation. */

import type { ChatMessage } from "../../store/chat";

/** Split messages into settled (above hold pulse) and queued drafts. */
export function partitionByQueued(messages: ChatMessage[]): {
  settled: ChatMessage[];
  queued: ChatMessage[];
} {
  return {
    settled: messages.filter((msg) => !msg.queued),
    queued: messages.filter((msg) => msg.queued),
  };
}

/** Stable row id for a thread message (historical and live seqs can collide). */
export function messageKey(msg: ChatMessage): string {
  return `${msg.historical ? "h" : "l"}-${msg.seq}-${msg.at}`;
}

/**
 * First call (`seed`) records the open-thread snapshot so those rows stay still.
 * Later rows that were not in the snapshot are live — except `historical`
 * hydrations that land after open (agent log fetch), which must not typewriter.
 */
export function trackIncoming(
  known: Set<string>,
  live: Set<string>,
  messages: ChatMessage[],
  seed: boolean,
): void {
  for (const msg of messages) {
    const key = messageKey(msg);
    if (seed) {
      known.add(key);
      continue;
    }
    if (known.has(key)) {
      continue;
    }
    known.add(key);
    if (!msg.historical) {
      live.add(key);
    }
  }
}
