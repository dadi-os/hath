import { isTauriRuntime } from "./shared/api/runtime";

export type Target = "desktop" | "mobile";

/** Desktop OS family for chrome layout (null in browser / mobile). */
export type DesktopOs = "macos" | "windows" | "linux";

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

/**
 * Desktop host OS for window chrome. Null when not a desktop Tauri shell
 * (browser, iOS, Android).
 */
export function detectDesktopOs(): DesktopOs | null {
  if (!isTauriRuntime()) {
    return null;
  }
  if (tauriPlatform === "macos") {
    return "macos";
  }
  if (tauriPlatform === "windows") {
    return "windows";
  }
  if (tauriPlatform === "linux") {
    return "linux";
  }
  return null;
}
