export type ConnectionState = "connected" | "connecting" | "disconnected";

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
