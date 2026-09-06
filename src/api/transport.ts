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

  connectionState(): ConnectionState;
  onConnectionChange(listener: (state: ConnectionState) => void): () => void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
