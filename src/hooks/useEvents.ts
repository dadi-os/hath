import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { DIMAAG_URL, dimaag, transport } from "../shared/api";
import type { AgentRecord, DimaagEvent } from "../shared/api/types";
import type { ConnectionState } from "../shared/api/transport";
import { subscribeConnection } from "../store/connection";
import {
  ingestLiveMessage,
  isUserThreadMessage,
  openAgent,
  seedConversations,
  setHistoryState,
  upsertConversation,
} from "../store/chat";
import { seedRunningFromAgents, setDadiBusy, setLaneRunning } from "../store/running";
import { logLine } from "../shared/lib/platform/log";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** React Query key for GET /agents. */
export const AGENTS_QUERY_KEY = ["agents"] as const;

function isDimaagEvent(data: unknown): data is DimaagEvent {
  if (!data || typeof data !== "object") {
    return false;
  }
  const type = (data as { type?: unknown }).type;
  return (
    type === "message" ||
    type === "lane_started" ||
    type === "lane_finished" ||
    type === "lane_failed" ||
    type === "dadi_started" ||
    type === "dadi_finished" ||
    type === "dadi_failed" ||
    type === "agent_spawned" ||
    type === "agent_modified"
  );
}

function agentNameFromCache(
  queryClient: QueryClient,
  agentId: string,
): string {
  const agents = queryClient.getQueryData<AgentRecord[]>(AGENTS_QUERY_KEY);
  return agents?.find((a) => a.id === agentId)?.name ?? agentId;
}

async function refetchAgents(queryClient: QueryClient): Promise<void> {
  const { agents } = await dimaag.listAgents();
  seedRunningFromAgents(agents);
  queryClient.setQueryData(AGENTS_QUERY_KEY, agents);
}

/** Seed conversation list from durable GET /threads. */
async function hydrateHistory(): Promise<void> {
  setHistoryState("loading");
  try {
    const { threads } = await dimaag.listThreads();
    seedConversations(threads);
    setHistoryState("ready");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setHistoryState("error", message);
    logLine("error", message, "history_load_failed");
  }
}

/**
 * Subscribe to Dimaag SSE. Reconnects with backoff on drop and refetches
 * GET /agents plus GET /threads on reconnect (the stream has no replay).
 * An agent → user message opens that agent's thread.
 */
export function useEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let generation = 0;
    let backoff = INITIAL_BACKOFF_MS;
    let stopStream: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unwatchStream: (() => void) | null = null;
    let wasActive = false;
    let prevConn: ConnectionState = transport.connectionState();

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

      if (data.type === "message") {
        if (!isUserThreadMessage(data.from_agent_id, data.to_agent_id)) {
          return;
        }

        ingestLiveMessage(data.agent_id, {
          seq: data.seq,
          from_user: data.from_agent_id === null,
          content: data.content,
          at: data.at,
        });
        upsertConversation({
          agent_id: data.agent_id,
          agent_name: agentNameFromCache(queryClient, data.agent_id),
          last_message: data.content,
          last_at: data.at,
          from_user: data.from_agent_id === null,
        });
        if (data.from_agent_id !== null) {
          openAgent(data.agent_id);
        }
        return;
      }

      if (data.type === "dadi_started") {
        setDadiBusy(true);
        return;
      }

      if (data.type === "dadi_finished" || data.type === "dadi_failed") {
        setDadiBusy(false);
        return;
      }

      if (data.type === "lane_started") {
        setLaneRunning(data.agent_id, data.lane, true);
        return;
      }

      if (data.type === "lane_finished") {
        setLaneRunning(data.agent_id, data.lane, false);
        return;
      }

      if (data.type === "lane_failed") {
        setLaneRunning(data.agent_id, data.lane, false);
        return;
      }

      if (data.type === "agent_spawned" || data.type === "agent_modified") {
        void queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
        void queryClient.invalidateQueries({
          queryKey: ["agent", data.agent_id],
        });
        if (data.type === "agent_spawned" && data.parent_agent_id !== null) {
          void queryClient.invalidateQueries({
            queryKey: ["agent", data.parent_agent_id],
          });
        }
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
        await refetchAgents(queryClient);
        if (gen !== generation) {
          return;
        }
        backoff = INITIAL_BACKOFF_MS;
      } catch {
        scheduleReconnect(gen);
        return;
      }

      teardownStream();
      void hydrateHistory();
      stopStream = transport.stream({
        baseUrl: DIMAAG_URL,
        path: "/events",
        onEvent: handleEvent,
        onClose: () => {
          if (gen !== generation || !transport.isActive()) {
            return;
          }
          teardownStream();
          scheduleReconnect(gen);
        },
      });

      unwatchStream = transport.onConnectionChange((state) => {
        if (gen !== generation) {
          return;
        }
        const prev = prevConn;
        prevConn = state;
        if (state === "reconnecting") {
          teardownStream();
          return;
        }
        if (
          state === "connected" &&
          prev === "reconnecting" &&
          transport.isActive()
        ) {
          teardownStream();
          clearTimer();
          backoff = INITIAL_BACKOFF_MS;
          void open(gen);
          return;
        }
        if (state === "disconnected") {
          teardownStream();
        }
      });
    };

    const onConnection = () => {
      const active = transport.isActive();
      if (active && !wasActive) {
        wasActive = true;
        generation += 1;
        backoff = INITIAL_BACKOFF_MS;
        prevConn = transport.connectionState();
        void open(generation);
        return;
      }
      if (!active && wasActive) {
        wasActive = false;
        generation += 1;
        clearTimer();
        teardownStream();
        setDadiBusy(false);
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
  }, [queryClient]);
}
