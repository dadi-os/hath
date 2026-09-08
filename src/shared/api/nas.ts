import type { Transport } from "./transport";

export type NasCpuStatus = {
  name: string;
  used_percent: number;
};

export type NasMemoryStatus = {
  name?: string;
  used_bytes: number;
  total_bytes: number;
  used_percent: number;
};

export type NasGpuStatus = {
  name: string;
  used_percent?: number;
};

export type NasStatus = {
  uptime_seconds: number;
  services: Array<{ name: string; healthy: boolean }>;
  disk: { free_bytes: number; total_bytes: number };
  cpu?: NasCpuStatus;
  memory?: NasMemoryStatus;
  gpu?: NasGpuStatus[];
  errors: string[];
};

export type NasLogLevel = "debug" | "info" | "warn" | "error";

export type NasLogEntry = {
  time: string;
  service: string;
  level: string;
  msg: string;
  raw?: string;
};

export type NasLogsParams = {
  services?: string;
  level?: NasLogLevel;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
};

export function createNasClient(transport: Transport, baseUrl: string) {
  return {
    getStatus(): Promise<NasStatus> {
      return transport.request({
        baseUrl,
        path: "/status",
        method: "GET",
      });
    },

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

    getModuleEnv(name: "dwar" | "yaad" | "dimaag"): Promise<string> {
      return transport.request({
        baseUrl,
        path: `/modules/${name}/env`,
        method: "GET",
        responseType: "text",
      });
    },

    putModuleEnv(
      name: "dwar" | "yaad" | "dimaag",
      text: string,
    ): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: `/modules/${name}/env`,
        method: "PUT",
        bodyText: text,
      });
    },

    getDwarConfig(): Promise<string> {
      return transport.request({
        baseUrl,
        path: "/modules/dwar/config",
        method: "GET",
        responseType: "text",
      });
    },

    putDwarConfig(text: string): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: "/modules/dwar/config",
        method: "PUT",
        bodyText: text,
      });
    },

    restartModule(name: string): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: `/modules/${name}/restart`,
        method: "POST",
      });
    },

    stackUp(): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: "/stack/up",
        method: "POST",
      });
    },

    stackDown(): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: "/stack/down",
        method: "POST",
      });
    },

    getCloudflaredToken(): Promise<string> {
      return transport.request({
        baseUrl,
        path: "/cloudflared/token",
        method: "GET",
        responseType: "text",
      });
    },

    putCloudflaredToken(token: string): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: "/cloudflared/token",
        method: "PUT",
        bodyText: token,
      });
    },

    provision(nodeName: string): Promise<{ bundle: string }> {
      return transport.request({
        baseUrl,
        path: "/provision",
        method: "POST",
        body: { node_name: nodeName },
      });
    },
  };
}

export type NasClient = ReturnType<typeof createNasClient>;
