import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { DIMAAG_URL, dimaag, transport } from "../api";
import type { AgentRecord, DimaagEvent } from "../api/types";
import { subscribeConnection } from "../store/connection";
import {
  ingestLiveMessage,
  isUserThreadMessage,
  tryBindPendingNewChat,
  upsertConversation,
} from "../store/chat";
import { seedRunningFromAgents, setLaneRunning } from "../store/running";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** React Query key for GET /agents. */
export const AGENTS_QUERY_KEY = ["agents"] as const;

/** React Query key for GET /agents/root — does not change. */
export const ROOT_AGENT_QUERY_KEY = ["agents", "root"] as const;

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

function rootIdFromCache(queryClient: QueryClient): string | null {
  const root = queryClient.getQueryData<{ id: string }>(ROOT_AGENT_QUERY_KEY);
  if (root?.id) {
    return root.id;
  }
  const agents = queryClient.getQueryData<AgentRecord[]>(AGENTS_QUERY_KEY);
  if (!agents) {
    return null;
  }
  const roots = agents.filter((a) => a.parent_agent_id === null);
  return roots.length === 1 ? roots[0].id : null;
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

/**
 * Subscribe to Dimaag SSE. Reconnects with backoff on drop and refetches
 * GET /agents on reconnect (the stream has no replay).
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
        const rootId = rootIdFromCache(queryClient);
        if (
          !isUserThreadMessage(data.from_agent_id, data.to_agent_id) ||
          (rootId !== null && data.agent_id === rootId)
        ) {
          // Root traffic is routing, not conversation.
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
        tryBindPendingNewChat(
          data.agent_id,
          data.content,
          data.from_agent_id === null,
        );
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

      if (data.type === "agent_spawned" || data.type === "agent_modified") {
        void queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
        void queryClient.invalidateQueries({
          queryKey: ["agent", data.agent_id],
        });
        if (data.type === "agent_spawned") {
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
  }, [queryClient]);
}
