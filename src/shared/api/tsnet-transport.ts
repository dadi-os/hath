import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import {
  loadCredentials,
  type Credentials,
} from "./credentials";
import type { ConnectionState, Transport } from "./transport";
import { consumeSseBuffer } from "./sse";

/** Thrown when no provisioning credentials are stored (or override missing). */
export class NotProvisionedError extends Error {
  constructor(message = "Provisioning required") {
    super(message);
    this.name = "NotProvisionedError";
  }
}

const RETRY_MS = 3000;

/**
 * Transport that dials Dimaag/Yaad/Nas through an embedded tsnet node.
 * React talks to 127.0.0.1:PORT; Go proxies over the tailnet using X-Hath-Upstream.
 *
 * Connection state: any HTTP response from the local proxy means the mesh is up.
 * Upstream app errors (e.g. Yaad 502) must not flip the shell to unreachable.
 * Dial/fetch failures mark disconnected and schedule retry when auto-connected.
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

  /** True when connect failed for missing credentials (setup screen). */
  needsProvisioningKey(): boolean {
    return this.needsProvisioning;
  }

  /** Subscribe to provisioning-needed flips; returns unsubscribe. */
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
        throw err instanceof Error ? err : new Error(String(err));
      }
      this.scheduleRetry();
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

  /**
   * Proxy one request through the local tsnet listener.
   * Marks connected on any HTTP response; marks disconnected on dial failure.
   */
  async request<T>(opts: {
    baseUrl: string;
    path: string;
    method: "GET" | "POST" | "PUT";
    body?: unknown;
    bodyText?: string;
    responseType?: "json" | "text";
  }): Promise<T> {
    if (this.port === null || !this.active) {
      throw new Error("Not connected");
    }

    const url = `http://127.0.0.1:${this.port}${opts.path.startsWith("/") ? opts.path : `/${opts.path}`}`;
    const headers: Record<string, string> = {
      "X-Hath-Upstream": opts.baseUrl,
    };
    let body: string | undefined;
    if (opts.bodyText !== undefined) {
      headers["Content-Type"] = "text/plain; charset=utf-8";
      body = opts.bodyText;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.method,
        headers,
        body,
      });
    } catch (err) {
      this.markFailure();
      throw err instanceof Error ? err : new Error(String(err));
    }

    this.markSuccess();

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status} ${opts.method} ${url}: ${text}`);
    }

    if (opts.responseType === "text") {
      return (await response.text()) as T;
    }
    return (await response.json()) as T;
  }

  /**
   * Open SSE via the local proxy. Returns a no-op when not connected.
   * Marks connected when the proxy answers; dial failures mark disconnected.
   */
  stream(opts: {
    baseUrl: string;
    path: string;
    onEvent: (data: unknown) => void;
    onClose?: () => void;
  }): () => void {
    if (this.port === null || !this.active) {
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
      opts.onClose,
    );

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
      void this.connect();
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
    onClose?: () => void,
  ): Promise<void> {
    if (this.port === null) {
      return;
    }

    const url = `http://127.0.0.1:${this.port}${path.startsWith("/") ? path : `/${path}`}`;
    const closed = () => {
      if (!signal.aborted) {
        onClose?.();
      }
    };

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
        this.markSuccess();
        closed();
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

      closed();
    } catch {
      if (!signal.aborted) {
        this.markFailure();
        onClose?.();
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
