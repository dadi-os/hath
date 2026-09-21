import type { Transport } from "../transport";
import type {
  GharCommissionJob,
  GharDevice,
  GharRadioCommand,
  GharRoom,
} from "../types";

/** React Query key for GET /devices. Shared by the home widget and the Ghar page. */
export const GHAR_DEVICES_KEY = ["ghar", "devices"] as const;

/** React Query key for GET /rooms. */
export const GHAR_ROOMS_KEY = ["ghar", "rooms"] as const;

/**
 * Ghar HTTP client — rooms, devices, commissioning, and the Hath radio bridge.
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

    /** GET /rooms — every room, including the seeded unassigned room. */
    listRooms(): Promise<{ rooms: GharRoom[] }> {
      return transport.request({
        baseUrl,
        path: "/rooms",
        method: "GET",
      });
    },

    /** POST /rooms — create a room. */
    createRoom(name: string): Promise<GharRoom> {
      return transport.request({
        baseUrl,
        path: "/rooms",
        method: "POST",
        body: { name },
      });
    },

    /** PATCH /devices/:id — move a device into a room. */
    moveDevice(id: string, roomId: string): Promise<GharDevice> {
      return transport.request({
        baseUrl,
        path: `/devices/${id}`,
        method: "PATCH",
        body: { room: roomId },
      });
    },

    /** PATCH /devices/:id — rename a device. Sync does not overwrite this. */
    renameDevice(id: string, name: string): Promise<GharDevice> {
      return transport.request({
        baseUrl,
        path: `/devices/${id}`,
        method: "PATCH",
        body: { name },
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

    /** POST /devices/:id/command — dimmable level, 0–100. */
    setBrightness(id: string, level: number): Promise<void> {
      return transport.request({
        baseUrl,
        path: `/devices/${id}/command`,
        method: "POST",
        body: {
          capability: "dimmable",
          params: { level },
          cause: "user",
        },
      });
    },

    /**
     * POST /devices/:id/command — colorable hue and saturation.
     * Both are Matter units, 0–254.
     */
    setHue(id: string, hue: number, saturation: number): Promise<void> {
      return transport.request({
        baseUrl,
        path: `/devices/${id}/command`,
        method: "POST",
        body: {
          capability: "colorable",
          params: { hue, saturation },
          cause: "user",
        },
      });
    },

    /** POST /devices/:id/command — colorable color temperature in mireds. */
    setColorTemp(id: string, colorTemp: number): Promise<void> {
      return transport.request({
        baseUrl,
        path: `/devices/${id}/command`,
        method: "POST",
        body: {
          capability: "colorable",
          params: { color_temp: colorTemp },
          cause: "user",
        },
      });
    },

    /** POST /devices/:id/identify — blink the device. */
    identify(id: string): Promise<void> {
      return transport.request({
        baseUrl,
        path: `/devices/${id}/identify`,
        method: "POST",
      });
    },

    /**
     * POST /commission — start a job.
     * `radio: "nearby"` uses this computer's Bluetooth and requires `wifi`.
     */
    startCommission(body: {
      code: string;
      room_id?: string;
      radio?: "network" | "nearby";
      wifi?: { ssid: string; password: string };
    }): Promise<{ job_id: string }> {
      return transport.request({
        baseUrl,
        path: "/commission",
        method: "POST",
        body,
      });
    },

    /** GET /commission/:jobId — job status. Failed jobs are still HTTP 200. */
    getCommission(jobId: string): Promise<GharCommissionJob> {
      return transport.request({
        baseUrl,
        path: `/commission/${jobId}`,
        method: "GET",
      });
    },

    /** POST /radio/attach — become the Bluetooth radio for Ghar. */
    attachRadio(): Promise<{ session_id: string }> {
      return transport.request({
        baseUrl,
        path: "/radio/attach",
        method: "POST",
      });
    },

    /** POST /radio/detach — release the radio session. */
    detachRadio(sessionId: string): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: "/radio/detach",
        method: "POST",
        body: { session_id: sessionId },
      });
    },

    /**
     * GET /radio/commands — next GATT or scan command.
     * `waitMs` holds the request open when the queue is empty.
     */
    pollRadio(
      sessionId: string,
      waitMs: number,
    ): Promise<{ command: GharRadioCommand | null }> {
      const params = new URLSearchParams({
        session_id: sessionId,
        wait_ms: String(waitMs),
      });
      return transport.request({
        baseUrl,
        path: `/radio/commands?${params.toString()}`,
        method: "GET",
      });
    },

    /** POST /radio/reply — finish a command Ghar is waiting on. */
    replyRadio(body: {
      session_id: string;
      id: number;
      ok: boolean;
      error?: string;
    }): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: "/radio/reply",
        method: "POST",
        body,
      });
    },

    /** POST /radio/event — advertisement, notification, or disconnect. */
    postRadioEvent(body: {
      session_id: string;
      kind: "advertisement" | "notification" | "disconnected";
      address: string;
      value_b64?: string;
    }): Promise<{ status: string }> {
      return transport.request({
        baseUrl,
        path: "/radio/event",
        method: "POST",
        body,
      });
    },
  };
}

/** Ghar client shape returned by {@link createGharClient}. */
export type GharClient = ReturnType<typeof createGharClient>;
