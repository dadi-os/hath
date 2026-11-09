/** Coalesced `wake_activity` events: a running wake reports its counts at most once a second. */

import type { Db } from "../db/client.js";
import { wakeCounts } from "../db/wakes.js";
import type { EventBus } from "./events.js";
import type { RuntimeLog } from "./engine.js";

/** How often one wake may emit `wake_activity`. */
export const WAKE_ACTIVITY_INTERVAL_MS = 1000;

/**
 * WakeActivity turns the many log rows and messages a wake produces into one
 * `wake_activity` event per interval: the first touch starts a timer, touches while it
 * runs fold into it, and when it fires the wake's counts are read and emitted.
 */
export class WakeActivity {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly log: RuntimeLog,
    private readonly intervalMs = WAKE_ACTIVITY_INTERVAL_MS,
  ) {}

  /** touch notes that `wakeId` of `agentId` did something a client would show. */
  touch(agentId: string, wakeId: string): void {
    if (this.timers.has(wakeId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(wakeId);
      void this.emit(agentId, wakeId);
    }, this.intervalMs);
    timer.unref();
    this.timers.set(wakeId, timer);
  }

  /** stop drops a wake's pending event, as the wake ended. */
  stop(wakeId: string): void {
    const timer = this.timers.get(wakeId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(wakeId);
    }
  }

  private async emit(agentId: string, wakeId: string): Promise<void> {
    try {
      const counts = await wakeCounts(this.db, wakeId);
      this.events.emit({ type: "wake_activity", agent_id: agentId, wake_id: wakeId, counts });
    } catch (err) {
      this.log.error({ err, agentId, wakeId, code: "wake_activity_failed" }, "reading a wake's counts failed");
    }
  }
}
