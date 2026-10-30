/** HTTP client for Nas: helper tasks, the host filesystem, terminals, and the control plane. */

import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import { z } from "zod";
import type { Config } from "../config.js";
import { NAS } from "../constants.js";
import { HathError } from "../errors.js";

const reportSchema = z
  .object({
    seq: z.number().int(),
    task: z.string().min(1),
    kind: z.enum(["browser", "terminal"]),
    id: z.string().min(1),
    agent_id: z.string().min(1),
    state: z.enum(["done", "needs_input", "failed"]),
    text: z.string(),
    files: z.array(z.string()),
    at: z.string().min(1),
  })
  .passthrough();

const taskSchema = z
  .object({
    task: z.string().min(1),
    kind: z.enum(["browser", "terminal"]),
    id: z.string().min(1),
    owner: z.string(),
    steered_by: z.string(),
    purpose: z.string(),
    status: z.enum(["working", "idle", "asking", "asleep"]),
    state: z.string(),
    created_at: z.string(),
    last_activity: z.string(),
    last_report: reportSchema.nullish(),
  })
  .passthrough();

const terminalSchema = z.object({ id: z.string().min(1), cwd: z.string() }).passthrough();

const execResponseSchema = z
  .object({
    exit_code: z.number().int().nullable(),
    output: z.string(),
    truncated: z.boolean(),
    timed_out: z.boolean(),
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

/** One thing a helper handed back to an agent: its result, a question, or the error that stopped it. */
export type HelperReport = z.infer<typeof reportSchema>;
/** What Nas's event stream carries that hath follows: a helper's report, or a change to the task list. */
export type NasEvent = { type: "helper_report"; report: HelperReport } | { type: "changed" };
/** A helper task as Nas lists it. */
export type HelperTask = z.infer<typeof taskSchema>;
/** What starts a helper task, or steers a running one. */
export type TaskRequest = { agent_id: string; message: string; cwd?: string };
export type ExecRequest = {
  command: string;
  timeout_seconds?: number;
  max_bytes?: number;
};
export type ExecResponse = z.infer<typeof execResponseSchema>;
export type ReadFileRequest = {
  path: string;
  offset?: number;
  limit?: number;
  max_bytes?: number;
};
export type ReadFileBytesRequest = { path: string; max_bytes: number };
/** A text file (`content`) or any bytes (`data`, base64), not both. */
export type WriteFileRequest = { path: string } & ({ content: string } | { data: string });
export type EditFileRequest = { path: string; old_string: string; new_string: string };
export type GlobRequest = { pattern: string; cwd?: string; limit?: number };
export type GrepRequest = {
  pattern: string;
  cwd?: string;
  glob?: string;
  limit?: number;
  max_bytes?: number;
};

/** Nas surface used by agent tools. */
export type NasClient = {
  startTask: (kind: TaskKind, body: TaskRequest) => Promise<HelperTask>;
  steerTask: (kind: TaskKind, id: string, body: TaskRequest) => Promise<HelperTask>;
  listTasks: () => Promise<HelperTask[]>;
  getTask: (kind: TaskKind, id: string) => Promise<HelperTask>;
  /**
   * Open Nas's event stream and resolve once it is connected, with every helper report
   * and task-list change that follows. The stream has no replay and ends, by throwing,
   * when the connection drops.
   */
  openReports: (signal: AbortSignal) => Promise<AsyncIterable<NasEvent>>;
  createTerminal: (cwd?: string) => Promise<{ id: string; cwd: string }>;
  closeTerminal: (id: string) => Promise<void>;
  exec: (id: string, body: ExecRequest) => Promise<ExecResponse>;
  readFile: (body: ReadFileRequest) => Promise<z.infer<typeof readResponseSchema>>;
  readFileBytes: (
    body: ReadFileBytesRequest,
  ) => Promise<z.infer<typeof readBytesResponseSchema>>;
  writeFile: (body: WriteFileRequest) => Promise<z.infer<typeof writeResponseSchema>>;
  editFile: (body: EditFileRequest) => Promise<z.infer<typeof editResponseSchema>>;
  glob: (body: GlobRequest) => Promise<z.infer<typeof globResponseSchema>>;
  grep: (body: GrepRequest) => Promise<z.infer<typeof grepResponseSchema>>;
};

/** The two kinds of helper task. */
export type TaskKind = "browser" | "terminal";

/** Build a retrying axios client pointed at `NAS`. */
export function createNasClient(config: Config): NasClient {
  const http: AxiosInstance = axios.create({
    baseURL: NAS,
    timeout: config.nas.timeout_ms,
    headers: { "content-type": "application/json" },
  });

  /** Starting or steering a task may wake a browser first, which takes longer than other calls. */
  const TASK_TIMEOUT_MS = Math.max(config.nas.timeout_ms, 60_000);

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
    startTask: (kind, body) =>
      post(`/tasks/${kind}`, omitUndefined(body), taskSchema, { timeout: TASK_TIMEOUT_MS }),
    steerTask: (kind, id, body) =>
      post(`/tasks/${kind}/${encodeURIComponent(id)}/steer`, body, taskSchema, { timeout: TASK_TIMEOUT_MS }),
    listTasks: () => get("/tasks", z.array(taskSchema)),
    getTask: (kind, id) => get(`/tasks/${kind}/${encodeURIComponent(id)}`, taskSchema),
    openReports: (signal) => openReportStream(signal),
    createTerminal: (cwd) => post("/terminals", omitUndefined({ cwd }), terminalSchema),
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
    readFile: (body) => post("/fs/read", omitUndefined(body), readResponseSchema),
    readFileBytes: (body) => post("/fs/read_bytes", body, readBytesResponseSchema),
    writeFile: (body) => post("/fs/write", body, writeResponseSchema),
    editFile: (body) => post("/fs/edit", body, editResponseSchema),
    glob: (body) => post("/fs/glob", omitUndefined(body), globResponseSchema),
    grep: (body) => post("/fs/grep", omitUndefined(body), grepResponseSchema),
  };
}

/**
 * openReportStream connects to Nas's server-sent event stream and resolves once it answers,
 * yielding each `helper_report` and `changed` event and ignoring the rest. A malformed event, a refused
 * connection and a dropped stream all throw, so the caller reconnects and reconciles.
 */
async function openReportStream(signal: AbortSignal): Promise<AsyncIterable<NasEvent>> {
  const response = await fetch(`${NAS}/events`, { headers: { accept: "text/event-stream" }, signal });
  if (!response.ok || response.body === null) {
    throw new HathError(502, "nas", `Nas event stream refused: ${response.status}`);
  }
  const body = response.body;
  return { [Symbol.asyncIterator]: () => parseEvents(body) };
}

/**
 * parseEvents reads server-sent event frames from `body`, yielding the `helper_report` and
 * `changed` events and ignoring the rest. A frame that is not JSON or a report that does not
 * match its schema throws, and so does the end of the stream.
 */
export async function* parseEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<NasEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) {
        break;
      }
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data === "") {
        continue;
      }
      const event: unknown = JSON.parse(data);
      const type = typeof event === "object" && event !== null ? (event as { type?: unknown }).type : undefined;
      if (type === "helper_report") {
        yield { type, report: parseResponse(reportSchema, event) };
      } else if (type === "changed") {
        yield { type };
      }
    }
  }
  throw new HathError(502, "nas", "Nas event stream ended");
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
