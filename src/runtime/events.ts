/**
 * In-process pub/sub for runtime events (messages, lane lifecycle, agent changes).
 * A listener that throws is logged and skipped, so a broken subscriber cannot take down a lane run.
 */

import type { AttachmentSummary, Lane } from "../types/domain.js";
import type { RuntimeLog } from "./engine.js";

export type RuntimeEvent =
  | {
      type: "message";
      agent_id: string;
      from_agent_id: string | null;
      to_agent_id: string | null;
      content: string;
      attachments: AttachmentSummary[];
      seq: number;
      at: string;
    }
  | { type: "lane_started"; agent_id: string; lane: Lane; at: string }
  | { type: "lane_finished"; agent_id: string; lane: Lane; at: string }
  | {
      type: "lane_failed";
      agent_id: string;
      lane: Lane;
      message: string;
      at: string;
    }
  | {
      type: "router_started";
      at: string;
    }
  | { type: "router_finished"; at: string }
  | { type: "router_failed"; message: string; at: string }
  | {
      type: "agent_spawned";
      agent_id: string;
      parent_agent_id: string | null;
      name: string;
      at: string;
    }
  | {
      type: "agent_modified";
      agent_id: string;
      name: string;
      active: boolean;
      at: string;
    }
  | {
      type: "device_command";
      command_id: string;
      node_name: string;
      tool: string;
      args: Record<string, unknown>;
      at: string;
    };

type Listener = (event: RuntimeEvent) => void;

/** In-process fan-out of runtime events to SSE subscribers; a throwing listener is logged, not propagated. */
export class EventBus {
  constructor(private readonly log: RuntimeLog) {}

  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error({ event: event.type, error: message }, "runtime event listener failed");
      }
    }
  }
}
