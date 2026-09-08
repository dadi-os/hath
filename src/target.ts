import { isTauriRuntime } from "./shared/api/runtime";

export type Target = "desktop" | "mobile";

let tauriPlatform: string | null = null;

/**
 * Resolve Tauri OS platform once at boot so {@link detectTarget} stays sync.
 * No-op outside Tauri (avoids loading `@tauri-apps/plugin-os` in the browser).
 */
export async function prepareTarget(): Promise<void> {
  if (!isTauriRuntime()) {
    tauriPlatform = null;
    return;
  }
  const { platform } = await import("@tauri-apps/plugin-os");
  tauriPlatform = platform();
}

/** Runtime form factor. Do not infer from viewport width. */
export function detectTarget(): Target {
  if (!isTauriRuntime()) {
    return "desktop";
  }
  const p = tauriPlatform;
  return p === "ios" || p === "android" ? "mobile" : "desktop";
}
