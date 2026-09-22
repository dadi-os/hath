import type { Transport } from "../transport";
import type {
  ChaaviCreateLogin,
  ChaaviHealth,
  ChaaviItem,
  ChaaviItemKind,
  ChaaviLoginCredential,
  ChaaviUpdateLogin,
} from "../types";

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
 * Chaavi HTTP client — vault health, login CRUD, and decrypt-on-demand reveal.
 * List/detail never embed secrets; callers must call {@link revealLogin} explicitly.
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

    /** GET /v1/items/:id — one catalog row; never passwords. */
    getItem(id: string): Promise<ChaaviItem> {
      return transport.request({
        baseUrl,
        path: `/v1/items/${encodeURIComponent(id)}`,
        method: "GET",
      });
    },

    /** POST /v1/logins — create a login; returns metadata only. */
    createLogin(body: ChaaviCreateLogin): Promise<ChaaviItem> {
      return transport.request({
        baseUrl,
        path: "/v1/logins",
        method: "POST",
        body,
      });
    },

    /** PATCH /v1/items/:id — update a login; returns metadata only. */
    updateLogin(id: string, body: ChaaviUpdateLogin): Promise<ChaaviItem> {
      return transport.request({
        baseUrl,
        path: `/v1/items/${encodeURIComponent(id)}`,
        method: "PATCH",
        body,
      });
    },

    /** DELETE /v1/items/:id — remove a login. */
    deleteItem(id: string): Promise<void> {
      return transport.request({
        baseUrl,
        path: `/v1/items/${encodeURIComponent(id)}`,
        method: "DELETE",
      });
    },

    /** POST /v1/items/:id/login — decrypt username/password on demand. */
    revealLogin(id: string): Promise<ChaaviLoginCredential> {
      return transport.request({
        baseUrl,
        path: `/v1/items/${encodeURIComponent(id)}/login`,
        method: "POST",
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
