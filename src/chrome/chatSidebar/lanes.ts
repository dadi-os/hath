/** Pure helpers for chat sidebar lane/message presentation. */

import type { ChatMessage } from "../../store/chat";

/** Split messages into settled and queued (local hold while conversation busy). */
export function partitionByQueued(messages: ChatMessage[]): {
  settled: ChatMessage[];
  queued: ChatMessage[];
} {
  return {
    settled: messages.filter((msg) => !msg.queued),
    queued: messages.filter((msg) => msg.queued),
  };
}

/**
 * Stable row id for a thread message.
 * Optimistic sends keep `id` across seq promotion so the row does not remount.
 * Historical and live seqs can still collide, so those fall back to seq plus time.
 */
export function messageKey(msg: ChatMessage): string {
  if (msg.id) {
    return msg.id;
  }
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
