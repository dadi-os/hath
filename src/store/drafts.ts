/**
 * Per-conversation composer drafts, kept on this device only (localStorage).
 * Keyed by agent id, or `dadi` for the Talk to Dadi composer. Text only —
 * attachments are object URLs and do not survive a reload.
 */

const PREFIX = "hath.draft.";

/** Draft slot for the Talk to Dadi composer. */
export const DADI_DRAFT_KEY = "dadi";

/** Saved draft for a conversation; "" when nothing is saved for it. */
export function loadDraft(key: string): string {
  return localStorage.getItem(PREFIX + key) ?? "";
}

/** Save a draft; an empty or whitespace-only draft clears the slot. */
export function saveDraft(key: string, text: string): void {
  if (text.trim().length === 0) {
    localStorage.removeItem(PREFIX + key);
    return;
  }
  localStorage.setItem(PREFIX + key, text);
}
