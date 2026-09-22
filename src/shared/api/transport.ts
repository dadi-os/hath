/** Mesh reachability for the shell chrome. */
export type ConnectionState =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "disconnected";

/** True while the mesh is usable or mid-recover (not left / never joined). */
export function isMeshOnline(state: ConnectionState): boolean {
  return state === "connected" || state === "reconnecting";
}

/**
 * Wire abstraction for domain clients.
 * `baseUrl` is the mesh host (e.g. `http://dimaag.dadi`); `path` is the route.
 * Implementations may proxy through a local tsnet listener.
 */
export interface Transport {
  request<T>(opts: {
    baseUrl: string;
    path: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    /** When set, sent as text/plain instead of JSON.stringify(body). */
    bodyText?: string;
    /** Default json. Use text for .env / config.toml payloads; blob for screenshots. */
    responseType?: "json" | "text" | "blob";
  }): Promise<T>;

  /**
   * Open an SSE subscription. Returns an abort function.
   * Concurrent callers each get their own connection; one must not abort another.
   * No-op unsubscribe when not connected.
   */
  stream(opts: {
    baseUrl: string;
    path: string;
    onEvent: (data: unknown) => void;
    onClose?: () => void;
  }): () => void;

  /** True after connect() until disconnect() — drives event-stream reconnect. */
  isActive(): boolean;
  connectionState(): ConnectionState;
  onConnectionChange(listener: (state: ConnectionState) => void): () => void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Immediate health probe (wake / focus). No-op when not joined.
   * Optional — browser transport ignores it.
   */
  nudgeHealth?(): void;
}
