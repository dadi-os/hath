import type { Transport } from "./transport";
import type {
  NodeHistoryRecord,
  NodeResponse,
  QueryRequest,
  QueryResponse,
  RecallRequest,
  RecallResponse,
} from "./types";

export function createYaadClient(transport: Transport, baseUrl: string) {
  return {
    query(body: QueryRequest): Promise<QueryResponse> {
      return transport.request({
        baseUrl,
        path: "/query",
        method: "POST",
        body,
      });
    },

    recall(body: RecallRequest): Promise<RecallResponse> {
      return transport.request({
        baseUrl,
        path: "/recall",
        method: "POST",
        body,
      });
    },

    getNode(id: string): Promise<NodeResponse> {
      return transport.request({
        baseUrl,
        path: `/nodes/${id}`,
        method: "GET",
      });
    },

    getNodeHistory(id: string): Promise<{ history: NodeHistoryRecord[] }> {
      return transport.request({
        baseUrl,
        path: `/nodes/${id}/history`,
        method: "GET",
      });
    },

    searchHistory(body: {
      query: string;
      limit?: number;
    }): Promise<{ results: NodeHistoryRecord[] }> {
      return transport.request({
        baseUrl,
        path: "/history/search",
        method: "POST",
        body,
      });
    },
  };
}

export type YaadClient = ReturnType<typeof createYaadClient>;
