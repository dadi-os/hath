export type ConnectionState = "connected" | "connecting" | "disconnected";

export interface Transport {
  request<T>(opts: {
    baseUrl: string;
    path: string;
    method: "GET" | "POST";
    body?: unknown;
  }): Promise<T>;

  stream(opts: {
    baseUrl: string;
    path: string;
    onEvent: (data: unknown) => void;
  }): () => void;

  /** True after connect() until disconnect() — drives event-stream reconnect. */
  isActive(): boolean;
  connectionState(): ConnectionState;
  onConnectionChange(listener: (state: ConnectionState) => void): () => void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
