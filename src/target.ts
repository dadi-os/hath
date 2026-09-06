import { platform } from "@tauri-apps/plugin-os";

export type Target = "desktop" | "mobile";

/** Runtime form factor. Do not infer from viewport width. */
export function detectTarget(): Target {
  const p = platform();
  return p === "ios" || p === "android" ? "mobile" : "desktop";
}
