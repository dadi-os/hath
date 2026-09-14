/** Local execution of Dimaag hath_* tools on this Hath client. */

import { isTauriRuntime } from "../api/runtime";
import { loadCredentials } from "../api/credentials";

/** Typed failure returned to Dimaag as a command error. */
export class DeviceError extends Error {
  readonly type: string;

  constructor(type: string, message: string) {
    super(message);
    this.name = "DeviceError";
    this.type = type;
  }
}

/** Hath tools this client can execute locally. */
export type HathLocalTool =
  | "hath_get_info"
  | "hath_get_battery"
  | "hath_get_location"
  | "hath_get_network"
  | "hath_read_clipboard"
  | "hath_write_clipboard"
  | "hath_send_file";

/**
 * Run one hath_* tool against the local device.
 * @throws {DeviceError} when the OS denies or does not support the capability.
 */
export async function executeHathTool(
  tool: HathLocalTool,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!isTauriRuntime()) {
    throw new DeviceError(
      "capability_unsupported",
      "Hath remote tools require the Tauri client",
    );
  }

  switch (tool) {
    case "hath_get_info":
      return getInfo();
    case "hath_get_battery":
      return getBattery();
    case "hath_get_location":
      return getLocation();
    case "hath_get_network":
      return getNetwork();
    case "hath_read_clipboard":
      return readClipboard();
    case "hath_write_clipboard":
      return writeClipboard(requireString(args, "text"));
    case "hath_send_file":
      return sendFile({
        filename: requireString(args, "filename"),
        media_type: requireString(args, "media_type"),
        data: requireString(args, "data"),
      });
    default: {
      const _exhaustive: never = tool;
      throw new DeviceError("invalid_request", `unknown tool ${_exhaustive}`);
    }
  }
}

async function getInfo(): Promise<Record<string, unknown>> {
  const { platform, version, arch, locale } = await import("@tauri-apps/plugin-os");
  const credentials = await loadCredentials();
  if (!credentials) {
    throw new DeviceError("internal_error", "mesh credentials are not stored");
  }
  return {
    node_name: credentials.node_name,
    platform: platform(),
    os_version: version(),
    arch: arch(),
    locale: await locale(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    app_version: APP_VERSION,
  };
}

async function getBattery(): Promise<{ percent: number; charging: boolean }> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<{ percent: number; charging: boolean }>("device_get_battery");
  } catch (err) {
    throw mapInvokeError(err);
  }
}

function getLocation(): Promise<{
  latitude: number;
  longitude: number;
  accuracy: number;
  at: string;
}> {
  if (!("geolocation" in navigator)) {
    return Promise.reject(
      new DeviceError("capability_unsupported", "geolocation is not available"),
    );
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          at: new Date(pos.timestamp).toISOString(),
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(new DeviceError("permission_denied", err.message));
          return;
        }
        reject(new DeviceError("internal_error", err.message));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}

async function getNetwork(): Promise<Record<string, unknown>> {
  const { invoke } = await import("@tauri-apps/api/core");
  let mesh_status = 0;
  try {
    mesh_status = await invoke<number>("mesh_status");
  } catch (err) {
    throw mapInvokeError(err);
  }
  const connection = readConnection();
  return {
    mesh_up: mesh_status === 1,
    mesh_status,
    connection_type: connection.type,
    downlink_mbps: connection.downlink,
    ssid: null,
  };
}

async function readClipboard(): Promise<{ text: string }> {
  const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
  try {
    const text = await readText();
    return { text };
  } catch (err) {
    throw new DeviceError("permission_denied", errMessage(err));
  }
}

async function writeClipboard(text: string): Promise<{ written: true }> {
  const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
  try {
    await writeText(text);
    return { written: true };
  } catch (err) {
    throw new DeviceError("permission_denied", errMessage(err));
  }
}

async function sendFile(args: {
  filename: string;
  media_type: string;
  data: string;
}): Promise<{ path: string; media_type: string }> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const path = await invoke<string>("device_write_download", {
      filename: args.filename,
      data: args.data,
    });
    return { path, media_type: args.media_type };
  } catch (err) {
    throw mapInvokeError(err);
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new DeviceError("invalid_request", `${key} must be a string`);
  }
  return value;
}

function mapInvokeError(err: unknown): DeviceError {
  const message = errMessage(err);
  const match = /^(capability_unsupported|permission_denied|invalid_request|internal_error):\s*(.*)$/.exec(
    message,
  );
  if (match) {
    return new DeviceError(match[1], match[2] || message);
  }
  return new DeviceError("internal_error", message);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "device command failed";
}

function readConnection(): { type: string | null; downlink: number | null } {
  const nav = navigator as Navigator & {
    connection?: { type?: string; effectiveType?: string; downlink?: number };
  };
  const connection = nav.connection;
  if (!connection) {
    return { type: null, downlink: null };
  }
  return {
    type: connection.type ?? connection.effectiveType ?? null,
    downlink: typeof connection.downlink === "number" ? connection.downlink : null,
  };
}

/** App version stamped at build time from package.json. */
export const APP_VERSION = __HATH_APP_VERSION__;
