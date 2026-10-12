/**
 * In-process map of which agent last used which Nas browser or terminal.
 * Dies with the process, same as locks and the transcript. Spawn/list do not
 * attach — only worker tools that take a browser_id or terminal_id.
 */

import type { AgentSessions } from "../types/domain.js";

const IGNORE = new Set([
  "browser_spawn",
  "browser_list",
  "terminal_spawn",
  "terminal_list",
]);

/** HostSessions tracks which agent last used which Nas browser or terminal. */
export class HostSessions {
  private readonly browsers = new Map<string, number[]>();
  private readonly terminals = new Map<string, Map<string, string | null>>();

  /**
   * observe records a tool call against the caller. Close always drops the resource from
   * every agent (even when Nas returns an error — the resource is gone); other worker
   * tools move that id to the end of the caller's list.
   */
  observe(agentId: string, toolName: string, input: unknown, _isError: boolean): void {
    if (toolName === "browser_close") {
      const id = numberField(input, "browser_id");
      if (id !== null) {
        this.dropBrowser(id);
      }
      return;
    }
    if (toolName === "terminal_close") {
      const id = stringField(input, "terminal_id");
      if (id !== null) {
        this.dropTerminal(id);
      }
      return;
    }
    if (IGNORE.has(toolName)) {
      return;
    }
    if (
      toolName.startsWith("browser_") ||
      toolName === "chaavi_fill_login" ||
      toolName === "chaavi_fill_passkey" ||
      toolName === "chaavi_fill_card" ||
      (toolName === "chaavi_fill_secret" && numberField(input, "browser_id") !== null)
    ) {
      const id = numberField(input, "browser_id");
      if (id !== null) {
        this.touchBrowser(agentId, id);
      }
      return;
    }
    if (toolName.startsWith("terminal_") || toolName === "chaavi_fill_secret") {
      const id = stringField(input, "terminal_id");
      if (id !== null) {
        const command =
          toolName === "terminal_execute_shell" || toolName === "chaavi_fill_secret"
            ? stringField(input, "command")
            : undefined;
        this.touchTerminal(agentId, id, command);
      }
    }
  }

  /** forAgent returns sessions remembered for one agent, most recently used last. */
  forAgent(agentId: string): AgentSessions {
    const terminals = this.terminals.get(agentId);
    return {
      browsers: [...(this.browsers.get(agentId) ?? [])],
      terminals: terminals
        ? [...terminals.entries()].map(([id, lastCommand]) => ({
            id,
            last_command: lastCommand,
          }))
        : [],
    };
  }

  /** Move browserId to the end of agentId's list (MRU). */
  private touchBrowser(agentId: string, browserId: number): void {
    const current = this.browsers.get(agentId) ?? [];
    const next = current.filter((id) => id !== browserId);
    next.push(browserId);
    this.browsers.set(agentId, next);
  }

  /**
   * Move terminalId to the end of agentId's list (MRU).
   * When command is provided, store it as last_command; otherwise keep the prior value.
   */
  private touchTerminal(agentId: string, terminalId: string, command?: string | null): void {
    let byId = this.terminals.get(agentId);
    if (!byId) {
      byId = new Map();
      this.terminals.set(agentId, byId);
    }
    const prev = byId.get(terminalId) ?? null;
    if (command !== undefined && command !== null) {
      byId.delete(terminalId);
      byId.set(terminalId, command);
      return;
    }
    byId.delete(terminalId);
    byId.set(terminalId, prev);
  }

  /** Remove browserId from every agent's list. */
  private dropBrowser(browserId: number): void {
    for (const [agentId, ids] of this.browsers) {
      const next = ids.filter((id) => id !== browserId);
      if (next.length === 0) {
        this.browsers.delete(agentId);
      } else {
        this.browsers.set(agentId, next);
      }
    }
  }

  /** Remove terminalId from every agent's list. */
  private dropTerminal(terminalId: string): void {
    for (const [agentId, byId] of this.terminals) {
      if (!byId.delete(terminalId)) {
        continue;
      }
      if (byId.size === 0) {
        this.terminals.delete(agentId);
      }
    }
  }
}

/** Positive integer field from a tool input object, or null if missing/invalid. */
function numberField(input: unknown, key: string): number | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Non-empty string field from a tool input object, or null if missing/invalid. */
function stringField(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
