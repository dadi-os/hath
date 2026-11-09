/** Per-agent in-memory steer instructions and terminate flags. Dies with the process. */

/** Per-agent steering instructions for the work lane, plus the terminate flag that stops its next tool call and aborts its in-flight model call. */
export class SteerQueue {
  private readonly items = new Map<string, string[]>();
  private readonly terminate = new Set<string>();
  private readonly aborts = new Map<string, AbortController>();

  append(agentId: string, instruction: string): void {
    const list = this.items.get(agentId) ?? [];
    list.push(instruction);
    this.items.set(agentId, list);
  }

  /** Mark the work lane to stop: the next tool call must not run and the in-flight model call is aborted. */
  requestTerminate(agentId: string): void {
    this.terminate.add(agentId);
    this.abortFor(agentId).abort();
  }

  /** Aborts when terminate is requested for the agent's current work-lane wake. */
  signalFor(agentId: string): AbortSignal {
    return this.abortFor(agentId).signal;
  }

  private abortFor(agentId: string): AbortController {
    const existing = this.aborts.get(agentId);
    if (existing !== undefined) {
      return existing;
    }
    const created = new AbortController();
    this.aborts.set(agentId, created);
    return created;
  }

  /** True while the process lane has asked the work lane to stop. */
  isTerminate(agentId: string): boolean {
    return this.terminate.has(agentId);
  }

  /**
   * takeTerminate clears and returns whether terminate was set. Call when the
   * work-lane wake is exiting so a later wake starts clean.
   */
  takeTerminate(agentId: string): boolean {
    this.aborts.delete(agentId);
    if (!this.terminate.has(agentId)) {
      return false;
    }
    this.terminate.delete(agentId);
    return true;
  }

  drain(agentId: string): string[] {
    const list = this.items.get(agentId) ?? [];
    this.items.delete(agentId);
    return list;
  }

  hasItems(agentId: string): boolean {
    const list = this.items.get(agentId);
    return Boolean(list && list.length > 0);
  }
}

export const STEER_TURN_PREFIX = "Steering instructions from your process lane:";

/** The work-lane turn that delivers queued steering instructions as a numbered list. */
export function formatSteerTurn(instructions: string[]): string {
  const lines = instructions.map((item, index) => `${index + 1}. ${item}`);
  return `${STEER_TURN_PREFIX}\n${lines.join("\n")}`;
}
