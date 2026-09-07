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
  };
}

export type NasClient = ReturnType<typeof createNasClient>;
