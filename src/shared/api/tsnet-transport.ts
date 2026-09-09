import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import {
  loadCredentials,
  type Credentials,
} from "./credentials";
import { NotProvisionedError } from "./errors";
import type { ConnectionState, Transport } from "./transport";
import { consumeSseBuffer } from "./sse";

export { NotProvisionedError } from "./errors";

/**
 * Transport that dials Dimaag/Yaad/Nas through dadiMesh.
 *
 * Mesh hostnames stay in API constants (`http://dimaag.dadi`); the dialer
 * reaches them via `/@host/path` on the local mesh proxy (no X-Hath-Upstream).
 * Connection is explicit — no silent reconnect.
 */
export class MeshTransport implements Transport {
  private port: number | null = null;
  private state: ConnectionState = "disconnected";
  private active = false;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private streamAbort: AbortController | null = null;
  private needsProvisioning = false;
  private readonly provisioningListeners = new Set<(needed: boolean) => void>();

  isActive(): boolean {
    return this.active;
  }

  /** True when credentials are missing (onboarding). */
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
   * Load credentials and flip the onboarding flag without starting the tunnel.
   */
  async prepareProvisioning(): Promise<void> {
    const credentials = await loadCredentials();
    if (!credentials) {
      this.active = false;
      this.port = null;
      this.setProvisioningNeeded(true);
      this.setState("disconnected");
      return;
    }
    this.setProvisioningNeeded(false);
    this.setState("disconnected");
  }

  /**
   * Start dadiMesh. Pass `override` during first-run provisioning.
   * Does not schedule retries — leave/join is explicit (power control).
   */
  async connect(override?: Credentials): Promise<void> {
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
      this.active = false;
      this.setState("disconnected");
      if (override) {
        this.setProvisioningNeeded(true);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async disconnect(): Promise<void> {
    this.active = false;
    this.streamAbort?.abort();
    this.streamAbort = null;
    try {
      await invoke("mesh_stop");
    } finally {
      this.port = null;
      this.setState("disconnected");
    }
  }

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

    const host = meshHost(opts.baseUrl);
    const path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
    const url = `http://127.0.0.1:${this.port}/@${host}${path}`;
    const headers: Record<string, string> = {};
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
      throw new Error(
        `HTTP ${response.status} ${opts.method} ${opts.baseUrl}${path}: ${text}`,
      );
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
    return invoke<number>("mesh_start", {
      controlUrl: credentials.control_url,
      authKey: credentials.auth_key,
      nodeName: credentials.node_name,
    });
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

    const host = meshHost(baseUrl);
    const urlPath = path.startsWith("/") ? path : `/${path}`;
    const url = `http://127.0.0.1:${this.port}/@${host}${urlPath}`;
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
    this.active = false;
    this.port = null;
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

function meshHost(baseUrl: string): string {
  const host = new URL(baseUrl).host;
  if (!host) {
    throw new Error(`invalid mesh baseUrl: ${baseUrl}`);
  }
  return host;
}
