import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import {
  loadCredentials,
  type Credentials,
} from "./credentials";
import type { ConnectionState, Transport } from "./transport";
import { consumeSseBuffer } from "./sse";

export class NotProvisionedError extends Error {
  constructor(message = "Provisioning required") {
    super(message);
    this.name = "NotProvisionedError";
  }
}

const RETRY_MS = 3000;

/**
 * Transport that dials Dimaag/Yaad through an embedded tsnet node.
 * React talks to 127.0.0.1:PORT; Go proxies over the tailnet using X-Hath-Upstream.
 */
export class TsnetTransport implements Transport {
  private port: number | null = null;
  private state: ConnectionState = "disconnected";
  private active = false;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private streamAbort: AbortController | null = null;
  private needsProvisioning = false;
  private readonly provisioningListeners = new Set<(needed: boolean) => void>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  isActive(): boolean {
    return this.active;
  }

  needsProvisioningKey(): boolean {
    return this.needsProvisioning;
  }

  onProvisioningNeeded(listener: (needed: boolean) => void): () => void {
    this.provisioningListeners.add(listener);
    return () => {
      this.provisioningListeners.delete(listener);
    };
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

  /**
   * Start the mesh. Pass `override` during first-run provisioning so a bad
   * key is not persisted and does not start the unreachable retry loop.
   */
  async connect(override?: Credentials): Promise<void> {
    this.clearRetry();

    const credentials = override ?? (await loadCredentials());
    if (!credentials) {
      this.active = false;
      this.port = null;
      this.setProvisioningNeeded(true);
      this.setState("disconnected");
      throw new NotProvisionedError();
    }

    this.active = true;
    this.setProvisioningNeeded(false);
    this.setState("connecting");

    try {
      this.port = await this.startNode(credentials);
      this.setState("connected");
    } catch (err) {
      this.port = null;
      this.setState("disconnected");
      if (override) {
        this.active = false;
        this.setProvisioningNeeded(true);
      } else {
        this.scheduleRetry();
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async disconnect(): Promise<void> {
    this.active = false;
    this.clearRetry();
    this.streamAbort?.abort();
    this.streamAbort = null;
    try {
      await invoke("net_stop");
    } finally {
      this.port = null;
      this.setState("disconnected");
    }
  }

  async request<T>(opts: {
    baseUrl: string;
    path: string;
    method: "GET" | "POST";
    body?: unknown;
  }): Promise<T> {
    if (this.port === null || !this.active) {
      throw new Error("Not connected");
    }

    const url = `http://127.0.0.1:${this.port}${opts.path.startsWith("/") ? opts.path : `/${opts.path}`}`;
    const headers: Record<string, string> = {
      "X-Hath-Upstream": opts.baseUrl,
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    try {
      const response = await fetch(url, {
        method: opts.method,
        headers,
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
    if (this.port === null || !this.active) {
      return () => {};
    }

    this.streamAbort?.abort();
    const abort = new AbortController();
    this.streamAbort = abort;

    void this.readSse(opts.baseUrl, opts.path, opts.onEvent, abort.signal);

    return () => {
      abort.abort();
      if (this.streamAbort === abort) {
        this.streamAbort = null;
      }
    };
  }

  private async startNode(credentials: Credentials): Promise<number> {
    return invoke<number>("net_start", {
      controlUrl: credentials.control_url,
      authKey: credentials.auth_key,
      nodeName: credentials.node_name,
    });
  }

  private scheduleRetry(): void {
    if (!this.active || this.retryTimer !== null) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.active) {
        return;
      }
      void this.connect().catch(() => {
        // Unreachable: UI stays calm; retry continues while active.
      });
    }, RETRY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async readSse(
    baseUrl: string,
    path: string,
    onEvent: (data: unknown) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.port === null) {
      return;
    }

    const url = `http://127.0.0.1:${this.port}${path.startsWith("/") ? path : `/${path}`}`;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "X-Hath-Upstream": baseUrl,
        },
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
        buffer = consumeSseBuffer(buffer, onEvent);
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

  private setProvisioningNeeded(needed: boolean): void {
    if (this.needsProvisioning === needed) {
      return;
    }
    this.needsProvisioning = needed;
    for (const listener of this.provisioningListeners) {
      listener(needed);
    }
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
