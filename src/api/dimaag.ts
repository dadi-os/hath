import type { Transport } from "./transport";
import type {
  AgentDetail,
  AgentRecord,
  LogEvent,
  LogRecord,
} from "./types";

export function createDimaagClient(transport: Transport, baseUrl: string) {
  return {
    postMessage(body: { to_agent_id: string; content: string }): Promise<{ ok: true }> {
      return transport.request({
        baseUrl,
        path: "/messages",
        method: "POST",
        body,
      });
    },

    listAgents(): Promise<{ agents: AgentRecord[] }> {
      return transport.request({
        baseUrl,
        path: "/agents",
        method: "GET",
      });
    },

    getAgent(id: string): Promise<AgentDetail> {
      return transport.request({
        baseUrl,
        path: `/agents/${id}`,
        method: "GET",
      });
    },

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
  };
}

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
