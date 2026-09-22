/** Copy text to the system clipboard. */

import { isTauriRuntime } from "../../shared/api/runtime";

/**
 * Write `text` to the clipboard.
 * Tauri uses the clipboard plugin; the browser uses `navigator.clipboard`.
 * Failures propagate — callers must surface them.
 */
export async function copyText(text: string): Promise<void> {
  if (isTauriRuntime()) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}
