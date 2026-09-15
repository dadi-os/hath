import type { Transport } from "../transport";
import type { ChaaviHealth, ChaaviItem, ChaaviItemKind } from "../types";

/** Optional filters for Chaavi GET /v1/items. */
export type ChaaviItemsQuery = {
  /** Free-text name search. */
  q?: string;
  /** Filter items that match this URI. */
  uri?: string;
  /** Restrict to one catalog kind. */
  kind?: ChaaviItemKind;
};

/**
 * Chaavi HTTP client — vault health and item catalog (metadata only).
 * Paths live here; callers pass only domain args.
 */
export function createChaaviClient(transport: Transport, baseUrl: string) {
  return {
    /** GET /health — process liveness and vault ready/unconfigured. */
    getHealth(): Promise<ChaaviHealth> {
      return transport.request({
        baseUrl,
        path: "/health",
        method: "GET",
      });
    },

    /** GET /v1/items — catalog rows; never passwords. */
    listItems(query?: ChaaviItemsQuery): Promise<{ items: ChaaviItem[] }> {
      return transport.request({
        baseUrl,
        path: `/v1/items${toQuery(query)}`,
        method: "GET",
      });
    },
  };
}

/** Chaavi client shape returned by {@link createChaaviClient}. */
export type ChaaviClient = ReturnType<typeof createChaaviClient>;

/** Build a query string for {@link ChaaviItemsQuery}, or empty when unset. */
function toQuery(query?: ChaaviItemsQuery): string {
  if (!query) {
    return "";
  }
  const params = new URLSearchParams();
  if (query.q) {
    params.set("q", query.q);
  }
  if (query.uri) {
    params.set("uri", query.uri);
  }
  if (query.kind) {
    params.set("kind", query.kind);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}
