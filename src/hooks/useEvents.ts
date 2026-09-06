import { useEffect } from "react";
import { DIMAAG_URL, dimaag, transport } from "../api";
import type { DimaagEvent } from "../api/types";
import { subscribeConnection } from "../store/connection";
import { seedRunningFromAgents, setLaneRunning } from "../store/running";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

function isDimaagEvent(data: unknown): data is DimaagEvent {
  if (!data || typeof data !== "object") {
    return false;
  }
  const type = (data as { type?: unknown }).type;
  return (
    type === "message" ||
    type === "lane_started" ||
    type === "lane_finished" ||
    type === "agent_spawned" ||
    type === "agent_modified"
  );
}

async function refetchAgents(): Promise<void> {
  const { agents } = await dimaag.listAgents();
  seedRunningFromAgents(agents);
}

/**
 * Subscribe to Dimaag SSE. Reconnects with backoff on drop and refetches
 * GET /agents on reconnect (the stream has no replay).
 */
export function useEvents(): void {
  useEffect(() => {
    let generation = 0;
    let backoff = INITIAL_BACKOFF_MS;
    let stopStream: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unwatchStream: (() => void) | null = null;
    let wasActive = false;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const teardownStream = () => {
      unwatchStream?.();
      unwatchStream = null;
      stopStream?.();
      stopStream = null;
    };

    const handleEvent = (data: unknown) => {
      if (!isDimaagEvent(data)) {
        return;
      }
      if (data.type === "lane_started") {
        setLaneRunning(data.agent_id, data.lane, true);
      } else if (data.type === "lane_finished") {
        setLaneRunning(data.agent_id, data.lane, false);
      }
    };

    const scheduleReconnect = (gen: number) => {
      clearTimer();
      const delay = backoff;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      timer = setTimeout(() => {
        if (gen !== generation || !transport.isActive()) {
          return;
        }
        void open(gen);
      }, delay);
    };

    const open = async (gen: number) => {
      if (gen !== generation || !transport.isActive()) {
        return;
      }

      try {
        await refetchAgents();
        if (gen !== generation) {
          return;
        }
        backoff = INITIAL_BACKOFF_MS;
      } catch {
        scheduleReconnect(gen);
        return;
      }

      teardownStream();
      stopStream = transport.stream({
        baseUrl: DIMAAG_URL,
        path: "/events",
        onEvent: handleEvent,
      });

      unwatchStream = transport.onConnectionChange((state) => {
        if (gen !== generation) {
          return;
        }
        if (state === "disconnected" && transport.isActive()) {
          teardownStream();
          scheduleReconnect(gen);
        }
      });
    };

    const onConnection = () => {
      const active = transport.isActive();
      if (active && !wasActive) {
        wasActive = true;
        generation += 1;
        backoff = INITIAL_BACKOFF_MS;
        void open(generation);
        return;
      }
      if (!active && wasActive) {
        wasActive = false;
        generation += 1;
        clearTimer();
        teardownStream();
      }
    };

    const unsub = subscribeConnection(onConnection);
    onConnection();

    return () => {
      generation += 1;
      unsub();
      clearTimer();
      teardownStream();
    };
  }, []);
}
