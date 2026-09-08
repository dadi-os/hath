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
