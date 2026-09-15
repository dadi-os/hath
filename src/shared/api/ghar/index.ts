import type { Transport } from "../transport";
import type { GharDevice } from "../types";

/**
 * Ghar HTTP client — rooms/devices catalog and switch commands.
 * Paths live here; callers pass only domain args.
 */
export function createGharClient(transport: Transport, baseUrl: string) {
  return {
    /** GET /health — process liveness. */
    getHealth(): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: "/health",
        method: "GET",
      });
    },

    /** GET /devices — Matter devices grouped by room on the caller. */
    listDevices(): Promise<{ devices: GharDevice[] }> {
      return transport.request({
        baseUrl,
        path: "/devices",
        method: "GET",
      });
    },

    /** POST /devices/:id/command — switchable toggle. */
    toggleSwitch(id: string): Promise<void> {
      return transport.request({
        baseUrl,
        path: `/devices/${id}/command`,
        method: "POST",
        body: {
          capability: "switchable",
          params: { state: "toggle" },
          cause: "user",
        },
      });
    },
  };
}

/** Ghar client shape returned by {@link createGharClient}. */
export type GharClient = ReturnType<typeof createGharClient>;
