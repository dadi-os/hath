import { fetch } from "@tauri-apps/plugin-http";
import type { ConnectionState, Transport } from "./transport";

/**
 * HTTP transport via the Tauri HTTP plugin (Rust-side requests, no browser CORS).
 * connect/disconnect gate whether the client is active; connectionState also
 * tracks recent request success so the header can reflect live reachability.
 */
export class HttpTransport implements Transport {
  private state: ConnectionState = "disconnected";
  private active = false;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private streamAbort: AbortController | null = null;

  /** True after connect() until disconnect() — drives auto-reconnect. */
  isActive(): boolean {
    return this.active;
  }

  connectionState(): ConnectionState {
    return this.state;
  }

  onConnectionChange(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(): Promise<void> {
    this.active = true;
    this.setState("connecting");
  }

  async disconnect(): Promise<void> {
    this.active = false;
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.setState("disconnected");
  }

  async request<T>(opts: {
    baseUrl: string;
    path: string;
    method: "GET" | "POST";
    body?: unknown;
  }): Promise<T> {
    if (!this.active) {
      throw new Error("Transport is disconnected");
    }

    const url = joinUrl(opts.baseUrl, opts.path);
    try {
      const response = await fetch(url, {
        method: opts.method,
        headers:
          opts.body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });

      if (!response.ok) {
        const text = await response.text();
        this.markFailure();
        throw new Error(`HTTP ${response.status} ${opts.method} ${url}: ${text}`);
      }

      const data = (await response.json()) as T;
      this.markSuccess();
      return data;
    } catch (err) {
      this.markFailure();
      throw err;
    }
  }

  stream(opts: {
    baseUrl: string;
    path: string;
    onEvent: (data: unknown) => void;
  }): () => void {
    if (!this.active) {
      return () => {};
    }

    this.streamAbort?.abort();
    const abort = new AbortController();
    this.streamAbort = abort;

    void this.readSse(
      opts.baseUrl,
      opts.path,
      opts.onEvent,
      abort.signal,
    );

    return () => {
      abort.abort();
      if (this.streamAbort === abort) {
        this.streamAbort = null;
      }
    };
  }

  private async readSse(
    baseUrl: string,
    path: string,
    onEvent: (data: unknown) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const url = joinUrl(baseUrl, path);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal,
      });

      if (!response.ok || !response.body) {
        this.markFailure();
        return;
      }

      this.markSuccess();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const dataLine = chunk
            .split("\n")
            .find((line) => line.startsWith("data:"));
          if (!dataLine) {
            continue;
          }
          const raw = dataLine.slice(5).trim();
          if (!raw || raw === "[DONE]") {
            continue;
          }
          try {
            onEvent(JSON.parse(raw) as unknown);
          } catch {
            // Malformed SSE payload — skip; stream stays open.
          }
        }
      }

      if (!signal.aborted) {
        this.markFailure();
      }
    } catch {
      if (!signal.aborted) {
        this.markFailure();
      }
    }
  }

  private markSuccess(): void {
    if (!this.active) {
      return;
    }
    this.setState("connected");
  }

  private markFailure(): void {
    if (!this.active) {
      return;
    }
    this.setState("disconnected");
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
