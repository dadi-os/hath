import { HathError } from "../errors.js";

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  /** Undefined for a waiter that waits its turn without a deadline. */
  timer: ReturnType<typeof setTimeout> | undefined;
};

type LockState = {
  held: boolean;
  waiters: Waiter[];
};

/**
 * One single-flight lock per agent: its run, or the router's.
 * Waiters queue in memory. This assumes a single Hath process.
 */
export class RunLocks {
  private readonly states = new Map<string, LockState>();

  /** Held or queued. */
  isBusy(agentId: string): boolean {
    const state = this.states.get(agentId);
    return Boolean(state && (state.held || state.waiters.length > 0));
  }

  /** Currently held by a run. A waiter with no holder is not running. */
  isHeld(agentId: string): boolean {
    const state = this.states.get(agentId);
    return Boolean(state?.held);
  }

  /**
   * acquire resolves with a release once the agent's run is free. A waiter with a
   * `timeoutMs` fails with `503 run_busy` when it has not been granted in time;
   * a null timeout waits its turn however long the runs ahead of it take.
   */
  acquire(agentId: string, timeoutMs: number | null): Promise<() => void> {
    let state = this.states.get(agentId);
    if (!state) {
      state = { held: false, waiters: [] };
      this.states.set(agentId, state);
    }

    const grant = (): (() => void) => {
      state.held = true;
      return () => {
        state.held = false;
        const next = state.waiters.shift();
        if (next) {
          clearTimeout(next.timer);
          next.resolve(grant());
          return;
        }
        this.states.delete(agentId);
      };
    };

    if (!state.held && state.waiters.length === 0) {
      return Promise.resolve(grant());
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: timeoutMs === null ? undefined : setTimeout(() => {
          const idx = state.waiters.indexOf(waiter);
          if (idx >= 0) {
            state.waiters.splice(idx, 1);
          }
          reject(
            new HathError(
              503,
              "run_busy",
              `run queue timed out for ${agentId}`,
            ),
          );
        }, timeoutMs),
      };
      state.waiters.push(waiter);
    });
  }
}
