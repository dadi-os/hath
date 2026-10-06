import { HathError } from "../errors.js";
import type { Lane } from "../types/domain.js";

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  /** Undefined for a waiter that waits its turn without a deadline. */
  timer: ReturnType<typeof setTimeout> | undefined;
};

type LaneState = {
  held: boolean;
  waiters: Waiter[];
};

/**
 * Two independent single-flight locks per agent, one per lane.
 * Waiters queue in memory. This assumes a single Hath process.
 */
export class LaneLocks {
  private readonly states = new Map<string, LaneState>();

  private key(agentId: string, lane: Lane): string {
    return `${agentId}:${lane}`;
  }

  /** Held or queued. A steer must not start a second reasoning run in this case. */
  isBusy(agentId: string, lane: Lane): boolean {
    const state = this.states.get(this.key(agentId, lane));
    return Boolean(state && (state.held || state.waiters.length > 0));
  }

  /** Currently held by a run. A waiter with no holder is not running. */
  isHeld(agentId: string, lane: Lane): boolean {
    const state = this.states.get(this.key(agentId, lane));
    return Boolean(state?.held);
  }

  /**
   * acquire resolves with a release once the lane is free. A waiter with a
   * `timeoutMs` fails with `503 lane_busy` when it has not been granted in time;
   * a null timeout waits its turn however long the runs ahead of it take.
   */
  acquire(agentId: string, lane: Lane, timeoutMs: number | null): Promise<() => void> {
    const key = this.key(agentId, lane);
    let state = this.states.get(key);
    if (!state) {
      state = { held: false, waiters: [] };
      this.states.set(key, state);
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
        this.states.delete(key);
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
              "lane_busy",
              `${lane} lane queue timed out for agent ${agentId}`,
            ),
          );
        }, timeoutMs),
      };
      state.waiters.push(waiter);
    });
  }
}
