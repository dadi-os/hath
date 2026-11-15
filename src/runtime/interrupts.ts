/** Per-agent, in-memory control of the run in progress: what cancels its model call, and its stop flag. Dies with the process. */

/**
 * Interrupts lets the rest of hath act on an agent's running loop. A message from the requester
 * of the loop's job cancels the model call in flight (`preempt`), so the loop reads it before
 * going on; a stop (`stop`) also ends the run at its next step. Nothing here touches an agent
 * whose loop is not running.
 */
export class Interrupts {
  private readonly running = new Set<string>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly stops = new Set<string>();

  /** enter marks the agent's loop as running. */
  enter(agentId: string): void {
    this.running.add(agentId);
  }

  /** leave marks the loop as ended and clears whatever interrupt was left. */
  leave(agentId: string): void {
    this.running.delete(agentId);
    this.aborts.delete(agentId);
    this.stops.delete(agentId);
  }

  /** begin opens a cancellable stretch (one step's sync and model call) and returns its signal. */
  begin(agentId: string): AbortSignal {
    const controller = new AbortController();
    this.aborts.set(agentId, controller);
    return controller.signal;
  }

  /** preempt cancels the stretch in progress when the agent's loop is running; true when it did. */
  preempt(agentId: string): boolean {
    const controller = this.aborts.get(agentId);
    if (!this.running.has(agentId) || controller === undefined || controller.signal.aborted) {
      return false;
    }
    controller.abort();
    return true;
  }

  /** stop ends the agent's running loop at its next step and cancels its model call; true when a loop was running. */
  stop(agentId: string): boolean {
    if (!this.running.has(agentId)) {
      return false;
    }
    this.stops.add(agentId);
    this.preempt(agentId);
    return true;
  }

  /** isStopped is true after a stop of the agent's running loop. */
  isStopped(agentId: string): boolean {
    return this.stops.has(agentId);
  }
}
