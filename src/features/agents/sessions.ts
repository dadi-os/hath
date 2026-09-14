import type { AgentSessions } from "../../shared/api/types";

/** Live Nas browser row used to filter remembered session ids. */
export type LiveBrowser = { id: number };

/** Live Nas terminal row used to filter remembered session ids. */
export type LiveTerminal = { id: string };

/**
 * Most recently used remembered browser that is still alive on Nas.
 * Remembered order is oldest → newest.
 */
export function pickLiveBrowser(
  remembered: number[],
  live: LiveBrowser[],
): number | null {
  const ids = new Set(live.map((b) => b.id));
  for (let i = remembered.length - 1; i >= 0; i--) {
    const id = remembered[i];
    if (id !== undefined && ids.has(id)) {
      return id;
    }
  }
  return null;
}

/**
 * Most recently used remembered terminal that is still alive on Nas.
 */
export function pickLiveTerminal(
  remembered: AgentSessions["terminals"],
  live: LiveTerminal[],
): AgentSessions["terminals"][number] | null {
  const ids = new Set(live.map((t) => t.id));
  for (let i = remembered.length - 1; i >= 0; i--) {
    const row = remembered[i];
    if (row && ids.has(row.id)) {
      return row;
    }
  }
  return null;
}

/** True when the agent has any remembered host session (live check is separate). */
export function hasRememberedSessions(sessions: AgentSessions): boolean {
  return sessions.browsers.length > 0 || sessions.terminals.length > 0;
}
