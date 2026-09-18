/** Display helpers for the chat sidebar. */

/**
 * Collapse whitespace and truncate to a single line with an ellipsis.
 */
export function truncateOneLine(
  /** Source text. */
  text: string,
  /** Max characters including ellipsis. */
  max = 72,
): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) {
    return one;
  }
  return `${one.slice(0, max - 1)}…`;
}

export type ConversationBucket = "Today" | "Yesterday" | "Previous";

/**
 * ChatGPT-style list grouping for a conversation's last activity.
 */
export function conversationBucket(
  /** ISO-8601 timestamp. */
  iso: string,
  /** Reference instant in ms since epoch. */
  now = Date.now(),
): ConversationBucket {
  const at = new Date(iso).getTime();
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const todayMs = startToday.getTime();
  if (at >= todayMs) {
    return "Today";
  }
  const yesterdayMs = todayMs - 86_400_000;
  if (at >= yesterdayMs) {
    return "Yesterday";
  }
  return "Previous";
}

/**
 * Group conversations into Today / Yesterday / Previous, preserving newest-first order.
 */
export function groupConversations<T extends { last_at: string }>(
  conversations: T[],
  now = Date.now(),
): Array<{ bucket: ConversationBucket; items: T[] }> {
  const order: ConversationBucket[] = ["Today", "Yesterday", "Previous"];
  const buckets: Record<ConversationBucket, T[]> = {
    Today: [],
    Yesterday: [],
    Previous: [],
  };
  for (const conv of conversations) {
    buckets[conversationBucket(conv.last_at, now)].push(conv);
  }
  return order
    .filter((bucket) => buckets[bucket].length > 0)
    .map((bucket) => ({ bucket, items: buckets[bucket] }));
}

/**
 * Format an ISO timestamp as a relative English phrase (e.g. "3 minutes ago").
 */
export function formatRelative(
  /** ISO-8601 timestamp. */
  iso: string,
  /** Reference instant in ms since epoch. */
  now = Date.now(),
): string {
  const diffSec = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const abs = Math.abs(diffSec);
  if (abs < 60) {
    return rtf.format(diffSec, "second");
  }
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) {
    return rtf.format(diffMin, "minute");
  }
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) {
    return rtf.format(diffHour, "hour");
  }
  return rtf.format(Math.round(diffHour / 24), "day");
}
