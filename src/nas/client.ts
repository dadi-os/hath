/** HTTP client for Nas terminals and host filesystem. */

import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import { z } from "zod";
import type { Config } from "../config.js";
import { NAS } from "../constants.js";
import { HathError } from "../errors.js";

const createTerminalResponseSchema = z
  .object({
    id: z.string().min(1),
    cwd: z.string().min(1),
  })
  .passthrough();

const terminalInfoSchema = z
  .object({
    id: z.string().min(1),
    cwd: z.string(),
    created_at: z.string(),
    busy: z.boolean(),
  })
  .passthrough();

const execResponseSchema = z
  .object({
    exit_code: z.number().int().nullable(),
    output: z.string(),
    truncated: z.boolean(),
    timed_out: z.boolean(),
  })
  .passthrough();

const captureResponseSchema = z
  .object({
    output: z.string(),
  })
  .passthrough();

const keysResponseSchema = z
  .object({
    sent: z.literal(true),
  })
  .passthrough();

const readResponseSchema = z
  .object({
    content: z.string(),
    total_lines: z.number().int(),
    truncated: z.boolean(),
  })
  .passthrough();

const readBytesResponseSchema = z
  .object({
    /** The whole file, base64. */
    data: z.string(),
    size_bytes: z.number().int(),
  })
  .passthrough();

const writeResponseSchema = z
  .object({
    bytes: z.number().int(),
  })
  .passthrough();

const editResponseSchema = z
  .object({
    replaced: z.literal(true),
  })
  .passthrough();

const globResponseSchema = z
  .object({
    paths: z.array(z.string()),
    truncated: z.boolean(),
  })
  .passthrough();

const grepMatchSchema = z
  .object({
    path: z.string(),
    line: z.number().int(),
    text: z.string(),
  })
  .passthrough();

const grepResponseSchema = z
  .object({
    matches: z.array(grepMatchSchema),
    truncated: z.boolean(),
  })
  .passthrough();

const createBrowserResponseSchema = z
  .object({
    id: z.number().int(),
    display: z.string(),
    cdp_url: z.string().min(1),
    downloads_dir: z.string().min(1),
  })
  .passthrough();

const browserInfoSchema = z
  .object({
    id: z.number().int(),
    display: z.string(),
    cdp_url: z.string(),
    healthy: z.boolean(),
    downloads_dir: z.string().min(1),
  })
  .passthrough();

export type CreateTerminalRequest = { id?: string; cwd?: string };
export type CreateBrowserRequest = { id?: number };
export type CreateTerminalResponse = z.infer<typeof createTerminalResponseSchema>;
export type TerminalInfo = z.infer<typeof terminalInfoSchema>;
export type ExecRequest = {
  command: string;
  timeout_seconds?: number;
  max_bytes?: number;
};
export type ExecResponse = z.infer<typeof execResponseSchema>;
export type CaptureRequest = { lines?: number };
export type CaptureResponse = z.infer<typeof captureResponseSchema>;
export type KeysRequest = { keys: string[] };
export type ReadFileRequest = {
  path: string;
  offset?: number;
  limit?: number;
  max_bytes?: number;
};
export type ReadFileBytesRequest = { path: string; max_bytes: number };
export type WriteFileRequest = { path: string; content: string };
export type EditFileRequest = { path: string; old_string: string; new_string: string };
export type GlobRequest = { pattern: string; cwd?: string; limit?: number };
export type GrepRequest = {
  pattern: string;
  cwd?: string;
  glob?: string;
  limit?: number;
  max_bytes?: number;
};
export type CreateBrowserResponse = z.infer<typeof createBrowserResponseSchema>;
export type BrowserInfo = z.infer<typeof browserInfoSchema>;

const provisionResponseSchema = z.object({ bundle: z.string() }).passthrough();

const statusOkSchema = z.object({ status: z.string() }).passthrough();

const meshClientSchema = z
  .object({
    node_name: z.string().min(1),
    online: z.boolean(),
    last_seen: z.string().nullable(),
    ip_addresses: z.array(z.string()),
  })
  .passthrough();

const listClientsResponseSchema = z
  .object({
    clients: z.array(meshClientSchema),
  })
  .passthrough();

const updateRunSchema = z
  .object({
    state: z.enum(["idle", "running", "succeeded", "rebooting", "failed"]),
    scope: z.enum(["modules", "os", "all"]).optional(),
    started_at: z.string().optional(),
    finished_at: z.string().optional(),
    reboot_required: z.boolean(),
    error: z.string().optional(),
  })
  .passthrough();

const nasStatusSchema = z
  .object({
    uptime_seconds: z.number(),
    services: z.array(
      z.object({ name: z.string(), healthy: z.boolean() }).passthrough(),
    ),
    disk: z
      .object({ free_bytes: z.number(), total_bytes: z.number() })
      .passthrough(),
  })
  .passthrough();

const nasLogEntrySchema = z
  .object({
    time: z.string(),
    service: z.string(),
    level: z.string(),
    msg: z.string(),
    code: z.string().optional(),
    raw: z.string().optional(),
  })
  .passthrough();

export type NasStatus = z.infer<typeof nasStatusSchema>;
export type NasLogEntry = z.infer<typeof nasLogEntrySchema>;
export type PullUpdatesScope = "modules" | "os" | "all";
export type UpdateRun = z.infer<typeof updateRunSchema>;

export type NasLogsParams = {
  services?: string;
  level?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
};

/** Nas surface used by agent tools. */
export type NasClient = {
  createTerminal: (body?: CreateTerminalRequest) => Promise<CreateTerminalResponse>;
  listTerminals: () => Promise<TerminalInfo[]>;
  closeTerminal: (id: string) => Promise<void>;
  exec: (id: string, body: ExecRequest) => Promise<ExecResponse>;
  capture: (id: string, query?: CaptureRequest) => Promise<CaptureResponse>;
  sendKeys: (id: string, body: KeysRequest) => Promise<{ sent: true }>;
  readFile: (body: ReadFileRequest) => Promise<z.infer<typeof readResponseSchema>>;
  readFileBytes: (
    body: ReadFileBytesRequest,
  ) => Promise<z.infer<typeof readBytesResponseSchema>>;
  writeFile: (body: WriteFileRequest) => Promise<z.infer<typeof writeResponseSchema>>;
  editFile: (body: EditFileRequest) => Promise<z.infer<typeof editResponseSchema>>;
  glob: (body: GlobRequest) => Promise<z.infer<typeof globResponseSchema>>;
  grep: (body: GrepRequest) => Promise<z.infer<typeof grepResponseSchema>>;
  createBrowser: (body?: CreateBrowserRequest) => Promise<CreateBrowserResponse>;
  listBrowsers: () => Promise<BrowserInfo[]>;
  closeBrowser: (id: number) => Promise<void>;
  browserScreenshot: (id: number) => Promise<Buffer>;
  getStatus: () => Promise<NasStatus>;
  getLogs: (params?: NasLogsParams) => Promise<{ entries: NasLogEntry[] }>;
  restartModule: (name: string) => Promise<{ status: string }>;
  pullUpdates: (scope: PullUpdatesScope) => Promise<UpdateRun>;
  getUpdateStatus: () => Promise<UpdateRun>;
  stackUp: () => Promise<{ status: string }>;
  stackDown: () => Promise<{ status: string }>;
  provision: (nodeName: string) => Promise<{ bundle: string }>;
  listClients: () => Promise<{ clients: MeshClient[] }>;
};

export type MeshClient = {
  node_name: string;
  online: boolean;
  last_seen: string | null;
  ip_addresses: string[];
};

/** Build a retrying axios client pointed at `NAS`. */
export function createNasClient(config: Config): NasClient {
  const http: AxiosInstance = axios.create({
    baseURL: NAS,
    timeout: config.nas.timeout_ms,
    headers: { "content-type": "application/json" },
  });

  async function get<T>(
    path: string,
    schema: z.ZodType<T>,
    reqConfig?: AxiosRequestConfig,
  ): Promise<T> {
    const data = await withRetry(config, () =>
      http.get(path, reqConfig).then((res) => res.data),
    );
    return parseResponse(schema, data);
  }

  async function post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    reqConfig?: AxiosRequestConfig,
  ): Promise<T> {
    const data = await withRetry(config, () =>
      http.post(path, body, reqConfig).then((res) => res.data),
    );
    return parseResponse(schema, data);
  }

  async function del(path: string): Promise<void> {
    await withRetry(config, () => http.delete(path).then((res) => res.data));
  }

  return {
    createTerminal: (body = {}) =>
      post("/terminals", omitUndefined(body), createTerminalResponseSchema),
    listTerminals: () => get("/terminals", z.array(terminalInfoSchema)),
    closeTerminal: (id) => del(`/terminals/${encodeURIComponent(id)}`),
    exec: (id, body) => {
      const timeoutSeconds = body.timeout_seconds ?? 120;
      return post(
        `/terminals/${encodeURIComponent(id)}/exec`,
        omitUndefined(body),
        execResponseSchema,
        { timeout: (timeoutSeconds + 10) * 1000 },
      );
    },
    capture: (id, query = {}) =>
      get(
        `/terminals/${encodeURIComponent(id)}/capture`,
        captureResponseSchema,
        { params: omitUndefined(query) },
      ),
    sendKeys: (id, body) =>
      post(`/terminals/${encodeURIComponent(id)}/keys`, body, keysResponseSchema),
    readFile: (body) => post("/fs/read", omitUndefined(body), readResponseSchema),
    readFileBytes: (body) => post("/fs/read_bytes", body, readBytesResponseSchema),
    writeFile: (body) => post("/fs/write", body, writeResponseSchema),
    editFile: (body) => post("/fs/edit", body, editResponseSchema),
    glob: (body) => post("/fs/glob", omitUndefined(body), globResponseSchema),
    grep: (body) => post("/fs/grep", omitUndefined(body), grepResponseSchema),
    createBrowser: (body = {}) => post("/browsers", omitUndefined(body), createBrowserResponseSchema),
    listBrowsers: () => get("/browsers", z.array(browserInfoSchema)),
    closeBrowser: (id) => del(`/browsers/${id}`),
    browserScreenshot: async (id) => {
      const data = await withRetry(config, async () => {
        const res = await http.get(`/browsers/${id}/screenshot`, {
          responseType: "arraybuffer",
          timeout: Math.max(config.nas.timeout_ms, 60_000),
        });
        return Buffer.from(res.data as ArrayBuffer);
      });
      if (!Buffer.isBuffer(data)) {
        throw new HathError(502, "nas", "Nas screenshot response is malformed");
      }
      return data;
    },
    getStatus: () => get("/status", nasStatusSchema),
    getLogs: (params = {}) =>
      get("/logs", z.object({ entries: z.array(nasLogEntrySchema) }).passthrough(), {
        params: omitUndefined(params as Record<string, unknown>),
      }),
    restartModule: (name) =>
      post(`/modules/${encodeURIComponent(name)}/restart`, {}, statusOkSchema),
    pullUpdates: (scope) =>
      post("/pull_updates", { scope }, updateRunSchema),
    getUpdateStatus: () => get("/pull_updates", updateRunSchema),
    stackUp: () => post("/stack/up", {}, statusOkSchema),
    stackDown: () => post("/stack/down", {}, statusOkSchema),
    provision: (nodeName) =>
      post("/provision", { node_name: nodeName }, provisionResponseSchema),
    listClients: () => get("/clients", listClientsResponseSchema),
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

function parseResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new HathError(502, "nas", "Nas response is malformed");
  }
  return parsed.data;
}

async function withRetry(config: Config, fn: () => Promise<unknown>): Promise<unknown> {
  const { retry_attempts: attempts, backoff_ms: backoff } = config.nas;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) {
        throw mapNasError(err);
      }
    }
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    if (delay === undefined) {
      throw mapNasError(lastError);
    }
    await sleep(delay);
  }
  throw mapNasError(lastError);
}

/**
 * isRetryable retries network failures and 5xx responses. A 409 (busy terminal or edit-match
 * conflict) is never retried; the caller decides what to do about it.
 */
function isRetryable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) {
    return false;
  }
  if (!err.response) {
    return true;
  }
  if (err.response.status === 409) {
    return false;
  }
  return err.response.status >= 500;
}

const PASSTHROUGH_TYPES = new Set([
  "not_found",
  "busy",
  "forbidden",
  "binary_file",
  "invalid_request",
  "upstream_unreachable",
  "conflict",
  "stale_ref",
  "internal_error",
]);

function mapNasError(err: unknown): HathError {
  if (err instanceof HathError) {
    return err;
  }
  if (axios.isAxiosError(err)) {
    if (!err.response) {
      return new HathError(502, "nas", "Nas is unreachable");
    }
    const status = err.response.status;
    const data = err.response.data;

    const { type, message } = nasErrorParts(data);
    if (PASSTHROUGH_TYPES.has(type)) {
      return new HathError(status, type, message);
    }
    if (status >= 400 && status < 500) {
      return new HathError(status, "nas", message);
    }
    return new HathError(502, "nas", `Nas failed: ${message}`);
  }
  return new HathError(502, "nas", "Nas request failed");
}

function nasErrorParts(data: unknown): { type: string; message: string } {
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const type =
        "type" in error && typeof (error as { type: unknown }).type === "string"
          ? (error as { type: string }).type
          : "nas";
      const message =
        "message" in error &&
        typeof (error as { message: unknown }).message === "string" &&
        (error as { message: string }).message.length > 0
          ? (error as { message: string }).message
          : "Nas request failed";
      return { type, message };
    }
  }
  return { type: "nas", message: "Nas request failed" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
