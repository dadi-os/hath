import type { Transport } from "../transport";

/** Per-CPU sample from Nas GET /status. */
export type NasCpuStatus = {
  name: string;
  used_percent: number;
};

/** Memory sample from Nas GET /status. */
export type NasMemoryStatus = {
  name?: string;
  used_bytes: number;
  total_bytes: number;
  used_percent: number;
};

/** GPU sample from Nas GET /status. */
export type NasGpuStatus = {
  name: string;
  used_percent?: number;
};

/** Aggregate host + service health from Nas GET /status. */
export type NasStatus = {
  uptime_seconds: number;
  services: Array<{ name: string; healthy: boolean }>;
  disk: { free_bytes: number; total_bytes: number };
  cpu?: NasCpuStatus;
  memory?: NasMemoryStatus;
  gpu?: NasGpuStatus[];
  errors: string[];
};

/** Log severity filter for Nas GET /logs. */
export type NasLogLevel = "debug" | "info" | "warn" | "error";

/** One Loki-backed log row from Nas GET /logs. */
export type NasLogEntry = {
  time: string;
  service: string;
  level: string;
  msg: string;
  raw?: string;
};

/** Query params for Nas GET /logs. */
export type NasLogsParams = {
  services?: string;
  level?: NasLogLevel;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
};

/**
 * Nas HTTP client — status, logs, tunnel, stack, provision.
 * Paths live here; callers pass only domain args.
 */
export function createNasClient(transport: Transport, baseUrl: string) {
  return {
    /** GET /status — host + service health. */
    getStatus(): Promise<NasStatus> {
      return transport.request({
        baseUrl,
        path: "/status",
        method: "GET",
      });
    },

    /** GET /logs — Loki query via Nas. */
    getLogs(params?: NasLogsParams): Promise<{ entries: NasLogEntry[] }> {
      const qs = new URLSearchParams();
      if (params?.services) {
        qs.set("services", params.services);
      }
      if (params?.level) {
        qs.set("level", params.level);
      }
      if (params?.q) {
        qs.set("q", params.q);
      }
      if (params?.from) {
        qs.set("from", params.from);
      }
      if (params?.to) {
        qs.set("to", params.to);
      }
      if (params?.limit !== undefined) {
        qs.set("limit", String(params.limit));
      }
      const query = qs.toString();
      return transport.request({
        baseUrl,
        path: `/logs${query ? `?${query}` : ""}`,
        method: "GET",
      });
    },

    /** POST /modules/:name/restart. */
    restartModule(name: string): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: `/modules/${name}/restart`,
        method: "POST",
      });
    },

    /** POST /stack/up — bring compose stack up. */
    stackUp(): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: "/stack/up",
        method: "POST",
      });
    },

    /** POST /stack/down — take compose stack down. */
    stackDown(): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: "/stack/down",
        method: "POST",
      });
    },

    /** POST /pull_updates — apply module and/or OS updates. */
    pullUpdates(scope: "modules" | "os" | "all"): Promise<{
      status: string;
      scope: string;
      reboot_required: boolean;
    }> {
      return transport.request({
        baseUrl,
        path: "/pull_updates",
        method: "POST",
        body: { scope },
      });
    },

    /** GET /cloudflared/token — tunnel token text. */
    getCloudflaredToken(): Promise<string> {
      return transport.request({
        baseUrl,
        path: "/cloudflared/token",
        method: "GET",
        responseType: "text",
      });
    },

    /** PUT /cloudflared/token — replace tunnel token. */
    putCloudflaredToken(token: string): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: "/cloudflared/token",
        method: "PUT",
        bodyText: token,
      });
    },

    /** GET /headscale/control-url — public control plane URL for provision bundles. */
    getControlUrl(): Promise<string> {
      return transport.request({
        baseUrl,
        path: "/headscale/control-url",
        method: "GET",
        responseType: "text",
      });
    },

    /** PUT /headscale/control-url — persist control plane URL. */
    putControlUrl(url: string): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: "/headscale/control-url",
        method: "PUT",
        bodyText: url,
      });
    },

    /** POST /provision — mint a device setup bundle. */
    provision(nodeName: string): Promise<{ bundle: string }> {
      return transport.request({
        baseUrl,
        path: "/provision",
        method: "POST",
        body: { node_name: nodeName },
      });
    },

    /** GET /clients — Headscale mesh nodes for this appliance user. */
    listClients(): Promise<{
      clients: Array<{
        node_name: string;
        online: boolean;
        last_seen: string | null;
        ip_addresses: string[];
      }>;
    }> {
      return transport.request({
        baseUrl,
        path: "/clients",
        method: "GET",
      });
    },

    /** GET /browsers — live headed Chromium sessions on Nas. */
    listBrowsers(): Promise<
      Array<{ id: number; display: string; cdp_url: string; healthy: boolean }>
    > {
      return transport.request({
        baseUrl,
        path: "/browsers",
        method: "GET",
      });
    },
  };
}

/** Nas client shape returned by {@link createNasClient}. */
export type NasClient = ReturnType<typeof createNasClient>;
