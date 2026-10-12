/** HTTP client for Ghar device discovery, state, commands, and events. */

import axios, { type AxiosInstance } from "axios";
import { z } from "zod";
import type { Config } from "../config.js";
import { GHAR_BASE_URL } from "../constants.js";
import { HathError } from "../errors.js";

const capability = z.enum([
  "switchable",
  "dimmable",
  "colorable",
  "sensor",
  "lockable",
  "media",
  "thermostat",
]);

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
    room: z.object({ id: z.string().uuid(), name: z.string() }).passthrough(),
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

const stateResponseSchema = z
  .object({
    devices: z.record(z.record(attributeStateSchema)),
  })
  .passthrough();

const commandResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .passthrough();

const eventSchema = z
  .object({
    id: z.string(),
    device_id: z.string().uuid(),
    attribute_key: z.string(),
    old_value: z.unknown(),
    new_value: z.unknown(),
    cause: z.enum(["agent", "user", "external"]),
    cause_ref: z.string().nullable(),
    created_at: z.string(),
  })
  .passthrough();

const eventsResponseSchema = z
  .object({
    events: z.array(eventSchema),
  })
  .passthrough();

export type GharCapability = z.infer<typeof capability>;
export type GharDevice = z.infer<typeof deviceSchema>;
export type GharAttributeState = z.infer<typeof attributeStateSchema>;
export type GharEvent = z.infer<typeof eventSchema>;

export type ListDevicesRequest = {
  room?: string;
  tag?: string;
  capability?: GharCapability;
};

export type CommandRequest = {
  capability: GharCapability;
  params: Record<string, unknown>;
  cause?: "agent" | "user";
  cause_ref?: string;
};

export type ListEventsRequest = {
  device_id?: string | string[];
  room?: string;
  tag?: string;
  key?: string;
  since?: string;
  until?: string;
  cause?: "agent" | "user" | "external";
  limit?: number;
  order?: "asc" | "desc";
};

/** Ghar surface used by agent tools. */
export type GharClient = {
  listDevices: (query?: ListDevicesRequest) => Promise<{ devices: GharDevice[] }>;
  getState: () => Promise<{ devices: Record<string, Record<string, GharAttributeState>> }>;
  command: (deviceId: string, body: CommandRequest) => Promise<{ ok: true }>;
  listEvents: (query?: ListEventsRequest) => Promise<{ events: GharEvent[] }>;
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

  async function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const data = await withRetry(config, () => http.post(path, body).then((res) => res.data));
    return parseResponse(schema, data);
  }

  return {
    listDevices: (query = {}) => get("/devices", devicesResponseSchema, omitUndefined(query)),
    getState: () => get("/state", stateResponseSchema),
    command: (deviceId, body) =>
      post(`/devices/${deviceId}/command`, omitUndefined(body), commandResponseSchema),
    listEvents: (query = {}) => get("/events", eventsResponseSchema, omitUndefined(query)),
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
