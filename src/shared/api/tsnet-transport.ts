import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import {
  loadCredentials,
  type Credentials,
} from "./credentials";
import { NotProvisionedError } from "./errors";
import type { ConnectionState, Transport } from "./transport";
import { consumeSseBuffer } from "./sse";
import { logLine } from "../lib/platform/log";

export { NotProvisionedError } from "./errors";

/**
 * Legacy `mesh_start` port when desktop dialed `*.dadi` via the OS resolver.
 * Current desktop returns a local MagicDNS HTTP proxy port (`/@host`, same as iOS).
 */
const SYSTEM_MESH_PORT = 0;

/** Probe often so sleep/wake and brief flaps are caught quickly. */
const HEALTH_MS = 2_000;
/** Require consecutive bad probes before flipping to reconnecting. */
const FAIL_STREAK_BEFORE_RECOVER = 2;
const RECOVER_INITIAL_MS = 500;
const RECOVER_MAX_MS = 15_000;

/**
 * Transport that dials Dimaag/Yaad/Nas through dadiMesh.
 *
 * Desktop: system Tailscale TUN + local `/@host` proxy (MagicDNS, not libc).
 * iOS: in-process dialer → `http://127.0.0.1:<port>/@host/...`.
 * Join/leave is explicit; after a successful join, tunnel flaps auto-recover
 * with backoff until the user leaves. Recover uses `reconnecting` (not
 * `connecting`) so the power overlay does not cover the shell.
 */
export class MeshTransport implements Transport {
  private port: number | null = null;
  private state: ConnectionState = "disconnected";
  private active = false;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private streamAbort: AbortController | null = null;
  private needsProvisioning = false;
  private readonly provisioningListeners = new Set<(needed: boolean) => void>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private recoverTimer: ReturnType<typeof setTimeout> | null = null;
  private recovering = false;
  private recoverBackoff = RECOVER_INITIAL_MS;
  private healthGen = 0;
  private failStreak = 0;
  private wakeUnsub: (() => void) | null = null;

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
   * Onboarding stays up until `mesh_start` succeeds so a failed join does
   * not remount the scan/paste overlay.
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

    this.stopHealthWatch();
    this.active = true;
    this.setState("connecting");

    try {
      this.port = await this.startNode(credentials);
      this.setProvisioningNeeded(false);
      this.recoverBackoff = RECOVER_INITIAL_MS;
      this.failStreak = 0;
      this.setState("connected");
      this.startHealthWatch();
    } catch (err) {
      this.port = null;
      this.active = false;
      this.setState("disconnected");
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async disconnect(): Promise<void> {
    this.active = false;
    this.stopHealthWatch();
    this.streamAbort?.abort();
    this.streamAbort = null;
    try {
      await invoke("mesh_stop");
    } finally {
      this.port = null;
      this.setState("disconnected");
    }
  }

  /** Immediate probe after laptop wake / window focus. */
  nudgeHealth(): void {
    if (!this.active || this.recovering) {
      return;
    }
    void this.probeHealth();
  }

  async request<T>(opts: {
    baseUrl: string;
    path: string;
    method: "GET" | "POST" | "PUT";
    body?: unknown;
    bodyText?: string;
    responseType?: "json" | "text" | "blob";
  }): Promise<T> {
    if (this.port === null || !this.active) {
      throw new Error("Not connected");
    }

    const path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
    const url = this.meshUrl(opts.baseUrl, path);
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
      void this.probeHealth();
      throw err instanceof Error ? err : new Error(String(err));
    }

    this.failStreak = 0;
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
    if (opts.responseType === "blob") {
      return (await response.blob()) as T;
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

  /** Local `/@host` proxy; port `0` is the unused libc MagicDNS path. */
  private meshUrl(baseUrl: string, path: string): string {
    if (this.port === SYSTEM_MESH_PORT) {
      const base = baseUrl.replace(/\/$/, "");
      return `${base}${path}`;
    }
    const host = meshHost(baseUrl);
    return `http://127.0.0.1:${this.port}/@${host}${path}`;
  }

  private async startNode(credentials: Credentials): Promise<number> {
    return invoke<number>("mesh_start", {
      controlUrl: credentials.control_url,
      authKey: credentials.auth_key,
      nodeName: credentials.node_name,
    });
  }

  private startHealthWatch(): void {
    this.stopHealthWatchTimers();
    this.healthGen += 1;
    const gen = this.healthGen;
    this.healthTimer = setInterval(() => {
      if (gen !== this.healthGen) {
        return;
      }
      void this.probeHealth();
    }, HEALTH_MS);
    this.bindWakeListeners();
  }

  private stopHealthWatch(): void {
    this.healthGen += 1;
    this.recovering = false;
    this.failStreak = 0;
    this.stopHealthWatchTimers();
    this.unbindWakeListeners();
  }

  private stopHealthWatchTimers(): void {
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.recoverTimer !== null) {
      clearTimeout(this.recoverTimer);
      this.recoverTimer = null;
    }
  }

  /** Laptop lid / app focus — probe immediately instead of waiting for the interval. */
  private bindWakeListeners(): void {
    this.unbindWakeListeners();
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }
    const onVis = () => {
      if (document.visibilityState === "visible") {
        this.nudgeHealth();
      }
    };
    const onFocus = () => {
      this.nudgeHealth();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    this.wakeUnsub = () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
    };
  }

  private unbindWakeListeners(): void {
    this.wakeUnsub?.();
    this.wakeUnsub = null;
  }

  /**
   * Probe tunnel status only. App-module health is not a mesh flap.
   * Needs consecutive failures before recover to ride brief sleep/wake noise.
   */
  private async probeHealth(): Promise<void> {
    if (!this.active || this.recovering) {
      return;
    }
    try {
      const status = await invoke<number>("mesh_status");
      if (!this.active) {
        return;
      }
      if (status === 0) {
        this.failStreak += 1;
        if (this.failStreak >= FAIL_STREAK_BEFORE_RECOVER) {
          this.scheduleRecover("mesh_status offline");
        }
        return;
      }
      if (this.port === null) {
        this.failStreak += 1;
        if (this.failStreak >= FAIL_STREAK_BEFORE_RECOVER) {
          this.scheduleRecover("proxy port missing");
        }
        return;
      }
      this.failStreak = 0;
      this.markSuccess();
    } catch (err) {
      if (!this.active) {
        return;
      }
      this.failStreak += 1;
      if (this.failStreak >= FAIL_STREAK_BEFORE_RECOVER) {
        const message = err instanceof Error ? err.message : String(err);
        this.scheduleRecover(`mesh_status failed: ${message}`);
      }
    }
  }

  /** Debounce recover so a burst of failures shares one backoff loop. */
  private scheduleRecover(reason: string): void {
    if (!this.active || this.recovering || this.recoverTimer !== null) {
      return;
    }
    logLine("warn", `mesh recover scheduled: ${reason}`, "mesh_recover_scheduled");
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = null;
      void this.recover();
    }, 200);
  }

  /**
   * Re-run `mesh_start` with logged backoff while the user still wants to be joined.
   * Uses `reconnecting` so the shell stays interactive (no power overlay).
   */
  private async recover(): Promise<void> {
    if (!this.active || this.recovering) {
      return;
    }
    this.recovering = true;
    this.setState("reconnecting");
    logLine("info", "mesh recover started", "mesh_recover_started");

    try {
      while (this.active) {
        try {
          const credentials = await loadCredentials();
          if (!credentials) {
            this.active = false;
            this.port = null;
            this.setProvisioningNeeded(true);
            this.setState("disconnected");
            logLine(
              "error",
              "mesh recover stopped: credentials missing",
              "mesh_recover_unprovisioned",
            );
            return;
          }
          this.port = await this.startNode(credentials);
          if (!this.active) {
            return;
          }
          this.recoverBackoff = RECOVER_INITIAL_MS;
          this.failStreak = 0;
          this.setState("connected");
          this.startHealthWatch();
          logLine("info", "mesh recover succeeded", "mesh_recover_ok");
          return;
        } catch (err) {
          if (!this.active) {
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          logLine(
            "error",
            `mesh recover attempt failed (retry ${this.recoverBackoff}ms): ${message}`,
            "mesh_recover_failed",
          );
          await sleep(this.recoverBackoff);
          this.recoverBackoff = Math.min(
            this.recoverBackoff * 2,
            RECOVER_MAX_MS,
          );
        }
      }
    } finally {
      this.recovering = false;
      if (!this.active) {
        this.setState("disconnected");
      }
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

    const urlPath = path.startsWith("/") ? path : `/${path}`;
    const url = this.meshUrl(baseUrl, urlPath);
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
        void this.probeHealth();
        onClose?.();
      }
    }
  }

  private markSuccess(): void {
    if (!this.active || this.recovering) {
      return;
    }
    this.setState("connected");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
