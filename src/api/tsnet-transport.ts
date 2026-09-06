import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import type { ConnectionState, Transport } from "./transport";
import { consumeSseBuffer } from "./sse";

export class AuthKeyRequiredError extends Error {
  constructor(message = "Headscale pre-auth key required") {
    super(message);
    this.name = "AuthKeyRequiredError";
  }
}

function looksLikeAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("auth key required") ||
    lower.includes("auth") ||
    lower.includes("unauthorized") ||
    lower.includes("preauth") ||
    lower.includes("pre-auth") ||
    lower.includes("login")
  );
}

async function loadStoredAuthKey(): Promise<string | null> {
  return invoke<string | null>("net_load_auth_key");
}

export async function saveAuthKey(authKey: string): Promise<void> {
  await invoke("net_save_auth_key", { authKey });
}

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
  private needsAuthKey = false;
  private readonly authListeners = new Set<(needed: boolean) => void>();

  isActive(): boolean {
    return this.active;
  }

  authKeyNeeded(): boolean {
    return this.needsAuthKey;
  }

  onAuthKeyNeeded(listener: (needed: boolean) => void): () => void {
    this.authListeners.add(listener);
    return () => {
      this.authListeners.delete(listener);
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

  async connect(): Promise<void> {
    const controlUrl = import.meta.env.HATH_CONTROL_URL;
    if (!controlUrl) {
      throw new Error("HATH_CONTROL_URL is required when using tsnet");
    }

    this.active = true;
    this.setAuthNeeded(false);
    this.setState("connecting");

    try {
      const authKey = (await loadStoredAuthKey()) ?? "";
      this.port = await invoke<number>("net_start", {
        controlUrl,
        authKey,
      });
      this.setState("connected");
    } catch (err) {
      this.active = false;
      this.port = null;
      this.setState("disconnected");
      const message = err instanceof Error ? err.message : String(err);
      const stored = await loadStoredAuthKey();
      if (!stored && looksLikeAuthError(message)) {
        this.setAuthNeeded(true);
        throw new AuthKeyRequiredError(message);
      }
      throw err instanceof Error ? err : new Error(message);
    }
  }

  async disconnect(): Promise<void> {
    this.active = false;
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

  private setAuthNeeded(needed: boolean): void {
    if (this.needsAuthKey === needed) {
      return;
    }
    this.needsAuthKey = needed;
    for (const listener of this.authListeners) {
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
