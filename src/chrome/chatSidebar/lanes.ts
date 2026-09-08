/** Pure helpers for chat sidebar lane/message presentation. */

import type { ChatMessage, PendingNewChatMessage } from "../../store/chat";

/**
 * Map provisional pending-new-chat rows into ChatMessage shapes for the thread view.
 */
export function pendingToChatMessages(
  messages: PendingNewChatMessage[],
): ChatMessage[] {
  return messages.map((m) => ({
    seq: m.seq,
    from_user: true,
    content: m.content,
    at: m.at,
    pending: m.pending,
    failed: m.failed,
    queued: m.queued,
    attachments: m.attachments,
    outboundText: m.outboundText,
  }));
}

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
