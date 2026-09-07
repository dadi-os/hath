import type { Transport } from "./transport";

export type NasStatus = {
  uptime_seconds: number;
  services: Array<{ name: string; healthy: boolean }>;
  disk: { free_bytes: number; total_bytes: number };
  errors: string[];
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
  };
}

export type NasClient = ReturnType<typeof createNasClient>;
