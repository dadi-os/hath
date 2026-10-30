/**
 * The browser and terminal tasks each agent has in Nas, for `GET /agents`. Nas holds the
 * tasks (see nas/service/helpers), so there is nothing here to keep in step: every call
 * reads them as they are.
 */

import type { HelperTask, NasClient } from "../nas/client.js";
import type { AgentSessions } from "../types/domain.js";

/** HostSessions reads the helper tasks Nas holds. */
export class HostSessions {
  constructor(private readonly nas: NasClient) {}

  /** snapshot is every task Nas holds right now, to hand to forAgent once per response. */
  snapshot(): Promise<HelperTask[]> {
    return this.nas.listTasks();
  }

  /** forAgent is the tasks `agentId` owns or last steered in `snapshot`, most recently active first. */
  forAgent(snapshot: HelperTask[], agentId: string): AgentSessions {
    return {
      tasks: snapshot
        .filter((task) => task.owner === agentId || task.steered_by === agentId)
        .map((task) => ({
          id: task.task,
          kind: task.kind,
          status: task.status,
          purpose: task.purpose,
          current: task.state,
          last_activity: task.last_activity,
        })),
    };
  }
}
