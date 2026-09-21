import { useEffect } from "react";
import { DIMAAG_URL, dimaag, transport, usingTsnet } from "../shared/api";
import { loadCredentials } from "../shared/api/credentials";
import type { ConnectionState } from "../shared/api/transport";
import {
  APP_VERSION,
  DeviceError,
  executeHathTool,
  type HathLocalTool,
} from "../shared/device/commands";
import { subscribeConnection } from "../store/connection";

const PRESENCE_INTERVAL_MS = 15_000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

const HATH_TOOLS = new Set<string>([
  "hath_get_info",
  "hath_get_battery",
  "hath_get_location",
  "hath_get_network",
  "hath_read_clipboard",
  "hath_write_clipboard",
  "hath_send_file",
]);

function isHathCommand(data: unknown): data is {
  type: "hath_command";
  command_id: string;
  node_name: string;
  tool: string;
  args: Record<string, unknown>;
  at: string;
} {
  if (!data || typeof data !== "object") {
    return false;
  }
  const event = data as Record<string, unknown>;
  return (
    event.type === "hath_command" &&
    typeof event.command_id === "string" &&
    typeof event.node_name === "string" &&
    typeof event.tool === "string" &&
    typeof event.args === "object" &&
    event.args !== null
  );
}

/**
 * Heartbeat + reverse-RPC listener for Dimaag hath_* tools.
 * Only active on Tauri mesh clients with stored credentials.
 */
export function useHathRemote(): void {
  useEffect(() => {
    if (!usingTsnet) {
      return;
    }

    let generation = 0;
    let backoff = INITIAL_BACKOFF_MS;
    let stopStream: (() => void) | null = null;
    let unwatchStream: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let presenceTimer: ReturnType<typeof setInterval> | null = null;
    let wasActive = false;
    let prevConn: ConnectionState = transport.connectionState();
    let nodeName: string | null = null;
    let platformName: string | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const clearPresence = () => {
      if (presenceTimer !== null) {
        clearInterval(presenceTimer);
        presenceTimer = null;
      }
    };

    const teardownStream = () => {
      unwatchStream?.();
      unwatchStream = null;
      stopStream?.();
      stopStream = null;
    };

    const sendPresence = async () => {
      if (!nodeName || !platformName || !transport.isActive()) {
        return;
      }
      await dimaag.postPresence({
        node_name: nodeName,
        platform: platformName,
        app_version: APP_VERSION,
      });
    };

    const handleCommand = async (data: unknown) => {
      if (!isHathCommand(data) || !nodeName || data.node_name !== nodeName) {
        return;
      }
      if (!HATH_TOOLS.has(data.tool)) {
        await dimaag.postCommandResult(data.command_id, {
          ok: false,
          error: {
            type: "invalid_request",
            message: `unsupported tool ${data.tool}`,
          },
        });
        return;
      }
      try {
        const result = await executeHathTool(
          data.tool as HathLocalTool,
          data.args,
        );
        await dimaag.postCommandResult(data.command_id, {
          ok: true,
          result,
        });
      } catch (err) {
        const type = err instanceof DeviceError ? err.type : "internal_error";
        const message =
          err instanceof Error ? err.message : "device command failed";
        await dimaag.postCommandResult(data.command_id, {
          ok: false,
          error: { type, message },
        });
      }
    };

    const scheduleReconnect = (gen: number) => {
      clearTimer();
      const delay = backoff;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      timer = setTimeout(() => {
        if (gen !== generation || !transport.isActive()) {
          return;
        }
        void open(gen);
      }, delay);
    };

    const open = async (gen: number) => {
      if (gen !== generation || !transport.isActive()) {
        return;
      }

      try {
        const credentials = await loadCredentials();
        if (!credentials) {
          scheduleReconnect(gen);
          return;
        }
        nodeName = credentials.node_name;
        const { platform } = await import("@tauri-apps/plugin-os");
        platformName = platform();
        await sendPresence();
        if (gen !== generation) {
          return;
        }
        backoff = INITIAL_BACKOFF_MS;
        clearPresence();
        presenceTimer = setInterval(() => {
          void sendPresence().catch((err) => {
            console.error("hath presence failed", err);
          });
        }, PRESENCE_INTERVAL_MS);
      } catch {
        scheduleReconnect(gen);
        return;
      }

      teardownStream();
      stopStream = transport.stream({
        baseUrl: DIMAAG_URL,
        path: "/events",
        onEvent: (data) => {
          void handleCommand(data);
        },
        onClose: () => {
          if (gen !== generation || !transport.isActive()) {
            return;
          }
          teardownStream();
          scheduleReconnect(gen);
        },
      });

      unwatchStream = transport.onConnectionChange((state) => {
        if (gen !== generation) {
          return;
        }
        const prev = prevConn;
        prevConn = state;
        if (state === "reconnecting") {
          teardownStream();
          return;
        }
        if (
          state === "connected" &&
          prev === "reconnecting" &&
          transport.isActive()
        ) {
          teardownStream();
          clearTimer();
          backoff = INITIAL_BACKOFF_MS;
          void open(gen);
          return;
        }
        if (state === "disconnected") {
          teardownStream();
        }
      });
    };

    const onConnection = () => {
      const active = transport.isActive();
      if (active && !wasActive) {
        wasActive = true;
        generation += 1;
        backoff = INITIAL_BACKOFF_MS;
        prevConn = transport.connectionState();
        void open(generation);
        return;
      }
      if (!active && wasActive) {
        wasActive = false;
        generation += 1;
        clearTimer();
        clearPresence();
        teardownStream();
      }
    };

    const unsub = subscribeConnection(onConnection);
    onConnection();

    return () => {
      generation += 1;
      unsub();
      clearTimer();
      clearPresence();
      teardownStream();
    };
  }, []);
}
