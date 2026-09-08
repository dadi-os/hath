/** Structured frontend logs aligned with the nas JSON contract. */

/**
 * Emit one JSON log line to stdout (dev tools). Prefer this over `console.error`
 * so levels and codes stay machine-readable.
 */
export function logLine(
  /** Log level. */
  level: "debug" | "info" | "warn" | "error",
  /** Human message; may include newlines. */
  msg: string,
  /** Optional stable error/event code. */
  code?: string,
): void {
  const payload: Record<string, string> = {
    time: new Date().toISOString(),
    level,
    service: "hath",
    msg,
  };
  if (code) {
    payload.code = code;
  }
  console.log(JSON.stringify(payload));
}
