import { NAS } from "./constants";
import { joinUrl } from "./sse";
import type { ConnectionState, Transport } from "./transport";
import { POLL_MS } from "../lib/ux/poll";

/**
 * Plain-browser Transport: native fetch + EventSource against mesh URLs.
 * ConnectionState tracks Nas `/health` on the house poll cadence. No
 * provisioning — connect/disconnect only start and stop the health loop.
 */
export class BrowserTransport implements Transport {
  private state: ConnectionState = "disconnected";
  private active = false;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private eventSource: EventSource | null = null;

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
    await this.pollHealth();
    this.startPolling();
  }

  async disconnect(): Promise<void> {
    this.active = false;
    this.stopPolling();
    this.closeEventSource();
    this.setState("disconnected");
  }

  async request<T>(opts: {
    baseUrl: string;
    path: string;
    method: "GET" | "POST" | "PUT";
    body?: unknown;
    bodyText?: string;
    responseType?: "json" | "text";
  }): Promise<T> {
    if (!this.active) {
      throw new Error("Not connected");
    }

    const url = joinUrl(opts.baseUrl, opts.path);
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (opts.bodyText !== undefined) {
      headers["Content-Type"] = "text/plain; charset=utf-8";
      body = opts.bodyText;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const response = await fetch(url, {
      method: opts.method,
      headers,
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status} ${opts.method} ${url}: ${text}`);
    }

    if (opts.responseType === "text") {
      return (await response.text()) as T;
    }
    return (await response.json()) as T;
  }

  stream(opts: {
    baseUrl: string;
    path: string;
    onEvent: (data: unknown) => void;
    onClose?: () => void;
  }): () => void {
    if (!this.active) {
      return () => {};
    }

    this.closeEventSource();
    const url = joinUrl(opts.baseUrl, opts.path);
    const es = new EventSource(url);
    this.eventSource = es;

    es.onmessage = (event) => {
      const raw = event.data?.trim();
      if (!raw || raw === "[DONE]") {
        return;
      }
      try {
        opts.onEvent(JSON.parse(raw) as unknown);
      } catch {
        // skip malformed payloads; keep the stream open
      }
    };

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        opts.onClose?.();
      }
    };

    return () => {
      es.close();
      if (this.eventSource === es) {
        this.eventSource = null;
      }
    };
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.pollHealth();
    }, POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollHealth(): Promise<void> {
    if (!this.active) {
      return;
    }
    try {
      const response = await fetch(joinUrl(NAS, "/health"));
      if (!this.active) {
        return;
      }
      this.setState(response.ok ? "connected" : "disconnected");
    } catch {
      if (this.active) {
        this.setState("disconnected");
      }
    }
  }

  private closeEventSource(): void {
    this.eventSource?.close();
    this.eventSource = null;
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
