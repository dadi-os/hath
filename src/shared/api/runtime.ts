/**
 * True when running inside a Tauri webview (desktop or mobile shell).
 * Does not import `@tauri-apps/*` — safe to evaluate in a plain browser.
 */
export function isTauriRuntime(): boolean {
  if (typeof globalThis === "undefined") {
    return false;
  }
  const g = globalThis as typeof globalThis & {
    isTauri?: boolean;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(g.isTauri) || "__TAURI_INTERNALS__" in g;
}

/** Which Transport implementation {@link createTransport} will construct. */
export type TransportKind = "tsnet" | "browser";

/** Sync selection used by tests and boot. */
export function selectTransportKind(): TransportKind {
  return isTauriRuntime() ? "tsnet" : "browser";
}
