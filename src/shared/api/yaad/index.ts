import type { Transport } from "../transport";
import type {
  NodeHistoryRecord,
  NodeResponse,
  QueryRequest,
  QueryResponse,
  RecallRequest,
  RecallResponse,
} from "../types";

/**
 * Yaad HTTP client — memory query, recall, and node history.
 * Paths live here; callers pass only domain args.
 */
export function createYaadClient(transport: Transport, baseUrl: string) {
  return {
    /** POST /query — structured node listing. */
    query(body: QueryRequest): Promise<QueryResponse> {
      return transport.request({
        baseUrl,
        path: "/query",
        method: "POST",
        body,
      });
    },

    /** POST /recall — graph-hop semantic recall. */
    recall(body: RecallRequest): Promise<RecallResponse> {
      return transport.request({
        baseUrl,
        path: "/recall",
        method: "POST",
        body,
      });
    },

    /** GET /nodes/:id — node with detail and edges. */
    getNode(id: string): Promise<NodeResponse> {
      return transport.request({
        baseUrl,
        path: `/nodes/${id}`,
        method: "GET",
      });
    },

    /** GET /nodes/:id/history — field-level change log. */
    getNodeHistory(id: string): Promise<{ history: NodeHistoryRecord[] }> {
      return transport.request({
        baseUrl,
        path: `/nodes/${id}/history`,
        method: "GET",
      });
    },

    /** POST /history/search — free-text history search. */
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

/** Yaad client shape returned by {@link createYaadClient}. */
export type YaadClient = ReturnType<typeof createYaadClient>;
