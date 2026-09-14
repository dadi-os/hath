import type { Transport } from "../transport";
import type {
  AgentDetail,
  AgentRecord,
  LogEvent,
  LogRecord,
  MessageAttachment,
  PostMessageResponse,
} from "../types";

/**
 * Dimaag HTTP client — agents, messages, and logs over the given transport.
 * Paths live here; callers pass only domain args.
 */
export function createDimaagClient(transport: Transport, baseUrl: string) {
  return {
    /** POST /messages — human or agent outbound. */
    postMessage(body: {
      to_agent_id: string;
      content: string;
      attachments?: MessageAttachment[];
    }): Promise<PostMessageResponse> {
      return transport.request({
        baseUrl,
        path: "/messages",
        method: "POST",
        body,
      });
    },

    /** GET /agents — flat roster including root. */
    listAgents(): Promise<{ agents: AgentRecord[] }> {
      return transport.request({
        baseUrl,
        path: "/agents",
        method: "GET",
      });
    },

    /** GET /agents/:id — detail with children and tools. */
    getAgent(id: string): Promise<AgentDetail> {
      return transport.request({
        baseUrl,
        path: `/agents/${id}`,
        method: "GET",
      });
    },

    /** Sole null-parent agent. Stable; cache under ["agents", "root"]. */
    getRootAgent(): Promise<AgentDetail> {
      return transport.request({
        baseUrl,
        path: "/agents/root",
        method: "GET",
      });
    },

    /** GET /agents/:id/logs — optional event filter and limit. */
    getAgentLogs(
      id: string,
      query?: { event?: LogEvent; limit?: number },
    ): Promise<{ logs: LogRecord[] }> {
      return transport.request({
        baseUrl,
        path: `/agents/${id}/logs${toQuery(query)}`,
        method: "GET",
      });
    },

    /** GET /logs — cross-agent log query. */
    getLogs(query?: {
      event?: LogEvent;
      limit?: number;
    }): Promise<{ logs: LogRecord[] }> {
      return transport.request({
        baseUrl,
        path: `/logs${toQuery(query)}`,
        method: "GET",
      });
    },

    /** POST /hath/presence — heartbeat for this mesh node. */
    postPresence(body: {
      node_name: string;
      platform: string;
      app_version: string;
    }): Promise<{
      node_name: string;
      platform: string;
      app_version: string;
      at: string;
    }> {
      return transport.request({
        baseUrl,
        path: "/hath/presence",
        method: "POST",
        body,
      });
    },

    /** POST /hath/commands/:id/result — complete a reverse-RPC command. */
    postCommandResult(
      commandId: string,
      body:
        | { ok: true; result: unknown }
        | { ok: false; error: { type: string; message: string } },
    ): Promise<{ accepted: true }> {
      return transport.request({
        baseUrl,
        path: `/hath/commands/${encodeURIComponent(commandId)}/result`,
        method: "POST",
        body,
      });
    },
  };
}

/** Dimaag client shape returned by {@link createDimaagClient}. */
export type DimaagClient = ReturnType<typeof createDimaagClient>;

function toQuery(query?: { event?: LogEvent; limit?: number }): string {
  if (!query) {
    return "";
  }
  const params = new URLSearchParams();
  if (query.event !== undefined) {
    params.set("event", query.event);
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}
