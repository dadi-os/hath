/** HTTP client for Ghar device discovery, state, commands, and events. */

import axios, { type AxiosInstance } from "axios";
import { z } from "zod";
import type { Config } from "../config.js";
import { GHAR_BASE_URL } from "../constants.js";
import { HathError } from "../errors.js";

/** Ghar capability names, as Ghar's capability table lists them. */
export const GHAR_CAPABILITIES = [
  "on_off",
  "level",
  "color",
  "cover",
  "fan",
  "thermostat",
  "lock",
  "sensor",
  "button",
  "alarm",
  "power_source",
  "energy",
  "valve",
  "pump",
  "rvc",
  "appliance",
  "mode",
  "temperature_control",
  "media",
  "camera",
] as const;

/** Ghar device kinds, from each endpoint's Matter device type. */
export const GHAR_KINDS = [
  "light",
  "plug",
  "switch",
  "cover",
  "fan",
  "air_purifier",
  "thermostat",
  "air_conditioner",
  "heat_pump",
  "water_heater",
  "lock",
  "contact",
  "occupancy",
  "light_sensor",
  "temperature",
  "humidity",
  "pressure",
  "flow",
  "leak",
  "freeze",
  "rain",
  "air_quality",
  "smoke_alarm",
  "energy_meter",
  "solar",
  "battery_storage",
  "ev_charger",
  "valve",
  "irrigation",
  "pump",
  "robot_vacuum",
  "washer",
  "dryer",
  "dishwasher",
  "refrigerator",
  "cabinet",
  "oven",
  "cooktop",
  "microwave",
  "extractor_hood",
  "speaker",
  "tv",
  "camera",
  "doorbell",
  "bridge",
  "other",
] as const;

const capability = z.enum(GHAR_CAPABILITIES);
const kind = z.enum(GHAR_KINDS);

const attributeStateSchema = z
  .object({
    value: z.unknown(),
    changed_at: z.string(),
  })
  .passthrough();

const deviceSchema = z
  .object({
    id: z.string().uuid(),
    node_id: z.string(),
    endpoint: z.number().int(),
    name: z.string(),
    kind,
    device_types: z.array(z.number().int()),
    bridge_name: z.string().nullable(),
    tags: z.array(z.object({ id: z.string().uuid(), name: z.string() }).passthrough()),
    capabilities: z.array(
      z.object({ capability, config: z.record(z.unknown()) }).passthrough(),
    ),
    online: z.boolean(),
    last_seen_at: z.string().nullable(),
    vendor_name: z.string().nullable(),
    product_name: z.string().nullable(),
    state: z.record(attributeStateSchema),
  })
  .passthrough();

const devicesResponseSchema = z
  .object({
    devices: z.array(deviceSchema),
  })
  .passthrough();

const controlRunSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["running", "done", "failed"]),
    result: z.string().optional(),
    error: z.object({ type: z.string(), message: z.string() }).passthrough().optional(),
  })
  .passthrough();

export type GharCapability = z.infer<typeof capability>;
export type GharKind = z.infer<typeof kind>;
export type GharDevice = z.infer<typeof deviceSchema>;
export type GharAttributeState = z.infer<typeof attributeStateSchema>;
export type GharControlRun = z.infer<typeof controlRunSchema>;

export type ListDevicesRequest = {
  tag?: string;
  capability?: GharCapability;
  kind?: GharKind;
};

/** A plain-language request for Ghar's control loop. */
export type ControlRequest = {
  request: string;
  /** The agent the commands are attributed to. */
  caller: string;
  /** How long Ghar holds the call for the run to settle before answering `running`. */
  wait_ms: number;
};

/** Ghar surface used by agent tools. */
export type GharClient = {
  listDevices: (query?: ListDevicesRequest) => Promise<{ devices: GharDevice[] }>;
  getDevice: (id: string) => Promise<GharDevice>;
  /** Starts a control run; never retried, since a repeated request could repeat its commands. */
  control: (body: ControlRequest) => Promise<GharControlRun>;
  getControl: (id: string) => Promise<GharControlRun>;
};

/** Build a retrying axios client pointed at `GHAR_BASE_URL`. */
export function createGharClient(config: Config): GharClient {
  const http: AxiosInstance = axios.create({
    baseURL: GHAR_BASE_URL,
    timeout: config.ghar.timeout_ms,
    headers: { "content-type": "application/json" },
    paramsSerializer: { serialize: serializeParams },
  });

  async function get<T>(
    path: string,
    schema: z.ZodType<T>,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const data = await withRetry(config, () =>
      http.get(path, params !== undefined ? { params } : undefined).then((res) => res.data),
    );
    return parseResponse(schema, data);
  }

  async function postOnce<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    try {
      return parseResponse(schema, (await http.post(path, body)).data);
    } catch (err) {
      throw mapGharError(err);
    }
  }

  return {
    listDevices: (query = {}) => get("/devices", devicesResponseSchema, omitUndefined(query)),
    getDevice: (id) => get(`/devices/${id}`, deviceSchema),
    control: (body) => postOnce("/control", body, controlRunSchema),
    getControl: (id) => get(`/control/${id}`, controlRunSchema),
  };
}

function omitUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** Repeat array keys the way Fastify query parsing expects (`k=a&k=b`). */
function serializeParams(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        search.append(key, String(item));
      }
      continue;
    }
    search.append(key, String(value));
  }
  return search.toString();
}

function parseResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new HathError(502, "ghar", "Ghar response is malformed");
  }
  return parsed.data;
}

async function withRetry(config: Config, fn: () => Promise<unknown>): Promise<unknown> {
  const { retry_attempts: attempts, backoff_ms: backoff } = config.ghar;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) {
        throw mapGharError(err);
      }
    }
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    if (delay === undefined) {
      throw mapGharError(lastError);
    }
    await sleep(delay);
  }
  throw mapGharError(lastError);
}

/**
 * isRetryable retries network failures and 5xx responses, except a device timeout (504):
 * a second attempt can double-apply a toggle.
 */
function isRetryable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) {
    return false;
  }
  if (!err.response) {
    return true;
  }
  if (err.response.status === 504) {
    return false;
  }
  return err.response.status >= 500;
}

function mapGharError(err: unknown): HathError {
  if (err instanceof HathError) {
    return err;
  }
  if (axios.isAxiosError(err)) {
    if (!err.response) {
      return new HathError(502, "ghar", "Ghar is unreachable");
    }
    const status = err.response.status;
    const { type, message } = gharErrorParts(err.response.data);
    if (
      type === "capability_unsupported" ||
      type === "command_rejected" ||
      type === "device_unreachable" ||
      type === "commissioning_failed" ||
      type === "conflict" ||
      type === "not_found" ||
      type === "invalid_request"
    ) {
      return new HathError(status, type, message);
    }
    if (status >= 400 && status < 500) {
      return new HathError(status, "ghar", message);
    }
    return new HathError(502, "ghar", `Ghar failed: ${message}`);
  }
  return new HathError(502, "ghar", "Ghar request failed");
}

function gharErrorParts(data: unknown): { type: string; message: string } {
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const type =
        "type" in error && typeof (error as { type: unknown }).type === "string"
          ? (error as { type: string }).type
          : "ghar";
      const message =
        "message" in error &&
        typeof (error as { message: unknown }).message === "string" &&
        (error as { message: string }).message.length > 0
          ? (error as { message: string }).message
          : "Ghar request failed";
      return { type, message };
    }
  }
  return { type: "ghar", message: "Ghar request failed" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
