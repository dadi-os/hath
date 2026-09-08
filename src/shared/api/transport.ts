/** Mesh reachability for the shell chrome (header ONLINE/OFFLINE). */
export type ConnectionState = "connected" | "connecting" | "disconnected";

/**
 * Wire abstraction for domain clients.
 * `baseUrl` is the mesh host (e.g. `http://dimaag.dadi`); `path` is the route.
 * Implementations may proxy through a local tsnet listener.
 */
export interface Transport {
  request<T>(opts: {
    baseUrl: string;
    path: string;
    method: "GET" | "POST" | "PUT";
    body?: unknown;
    /** When set, sent as text/plain instead of JSON.stringify(body). */
    bodyText?: string;
    /** Default json. Use text for .env / config.toml payloads. */
    responseType?: "json" | "text";
  }): Promise<T>;

  /**
   * Open an SSE subscription. Returns an abort function.
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
}
