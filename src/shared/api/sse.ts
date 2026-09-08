/**
 * Shared SSE chunk parsing for TsnetTransport.
 * Splits on blank lines, extracts `data:` payloads, skips [DONE]/malformed JSON.
 * Returns the unconsumed trailing buffer fragment.
 */
export function consumeSseBuffer(
  buffer: string,
  onEvent: (data: unknown) => void,
): string {
  const chunks = buffer.split("\n\n");
  const rest = chunks.pop() ?? "";
  for (const chunk of chunks) {
    const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) {
      continue;
    }
    const raw = dataLine.slice(5).trim();
    if (!raw || raw === "[DONE]") {
      continue;
    }
    try {
      onEvent(JSON.parse(raw) as unknown);
    } catch {
      continue;
    }  }
  return rest;
}

/** Join mesh base URL and path without double slashes. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
