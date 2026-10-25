/** HTTP client for Yaad recall, ingest, and node history. */

import axios, { type AxiosInstance } from "axios";
import { z } from "zod";
import type { Config } from "../config.js";
import { YAAD_BASE_URL } from "../constants.js";
import { HathError } from "../errors.js";

const nodeKind = z.enum(["person", "memory", "plan", "place"]);

const recallNodeSchema = z
  .object({
    id: z.string().uuid(),
    kind: nodeKind,
    title: z.string(),
    body: z.string().nullable(),
    occurred_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    detail: z.unknown().nullable(),
    hops: z.number().int(),
  })
  .passthrough();

const recallEdgeSchema = z
  .object({
    src_id: z.string().uuid(),
    dst_id: z.string().uuid(),
    type: z.string(),
    properties: z.record(z.unknown()),
  })
  .passthrough();

const recallResponseSchema = z
  .object({
    nodes: z.array(recallNodeSchema),
    edges: z.array(recallEdgeSchema),
    sufficient: z.boolean().nullable(),
    coverage: z.number().nullable(),
  })
  .passthrough();

const ingestResponseSchema = z
  .object({
    counts: z.record(z.number()),
    operations: z.array(z.unknown()),
    temp_ids: z.record(z.string()).optional(),
  })
  .passthrough();

const nodeHistoryRecordSchema = z
  .object({
    id: z.string(),
    node_id: z.string().uuid(),
    field: z.enum(["title", "body", "occurred_at", "deleted"]),
    old_value: z.string().nullable(),
    new_value: z.string().nullable(),
    changed_at: z.string(),
    source: z.enum(["manual", "agent", "ingest"]),
  })
  .passthrough();

export type RecallResponse = z.infer<typeof recallResponseSchema>;
export type IngestResponse = z.infer<typeof ingestResponseSchema>;
export type NodeHistoryRecord = z.infer<typeof nodeHistoryRecordSchema>;

/** Yaad `POST /recall` body: anchors from `from`, else the filters, else `query`. */
export type RecallRequest = {
  query?: string | undefined;
  from?: string[] | undefined;
  hops?: number | undefined;
  kind?: "person" | "memory" | "plan" | "place" | undefined;
  name?: string | undefined;
  occurred_from?: string | undefined;
  occurred_to?: string | undefined;
  status?: "idea" | "tentative" | "confirmed" | undefined;
  limit?: number | undefined;
};

export type IngestRequest = {
  text: string;
  occurred_at: string;
  participant_ids?: string[];
  source: "agent";
  /** Writing agent, recorded on every node the ingest creates. */
  agent_id: string;
};

/** Yaad surface used by agent tools. */
export type YaadClient = {
  recall: (body: RecallRequest) => Promise<RecallResponse>;
  ingest: (body: IngestRequest) => Promise<IngestResponse>;
  getNodeHistory: (id: string) => Promise<{ history: NodeHistoryRecord[] }>;
  searchHistory: (body: {
    query: string;
    limit?: number;
  }) => Promise<{ results: NodeHistoryRecord[] }>;
};

/** Build a retrying axios client pointed at `YAAD_BASE_URL`. */
export function createYaadClient(config: Config): YaadClient {
  const http: AxiosInstance = axios.create({
    baseURL: YAAD_BASE_URL,
    timeout: config.yaad.timeout_ms,
    headers: { "content-type": "application/json" },
  });

  async function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const data = await withRetry(config, () => http.post(path, body).then((res) => res.data));
    return parseResponse(schema, data);
  }

  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const data = await withRetry(config, () => http.get(path).then((res) => res.data));
    return parseResponse(schema, data);
  }

  return {
    recall: (body) => post("/recall", body, recallResponseSchema),
    ingest: (body) => post("/ingest", body, ingestResponseSchema),
    getNodeHistory: (id) =>
      get(
        `/nodes/${id}/history`,
        z.object({ history: z.array(nodeHistoryRecordSchema) }).passthrough(),
      ),
    searchHistory: (body) =>
      post(
        "/history/search",
        body,
        z.object({ results: z.array(nodeHistoryRecordSchema) }).passthrough(),
      ),
  };
}

function parseResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new HathError(502, "yaad", "Yaad response is malformed");
  }
  return parsed.data;
}

async function withRetry(config: Config, fn: () => Promise<unknown>): Promise<unknown> {
  const { retry_attempts: attempts, backoff_ms: backoff } = config.yaad;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) {
        throw mapYaadError(err);
      }
    }
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    if (delay === undefined) {
      throw mapYaadError(lastError);
    }
    await sleep(delay);
  }
  throw mapYaadError(lastError);
}

function isRetryable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) {
    return false;
  }
  if (!err.response) {
    return true;
  }
  return err.response.status >= 500;
}

function mapYaadError(err: unknown): HathError {
  if (err instanceof HathError) {
    return err;
  }
  if (axios.isAxiosError(err)) {
    if (!err.response) {
      return new HathError(502, "upstream_unreachable", "Yaad is unreachable");
    }
    const status = err.response.status;
    const message = yaadMessage(err.response.data);
    if (status >= 400 && status < 500) {
      return new HathError(status, "yaad", message);
    }
    return new HathError(502, "yaad", `Yaad failed: ${message}`);
  }
  return new HathError(502, "yaad", "Yaad request failed");
}

function yaadMessage(data: unknown): string {
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error: unknown }).error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message: unknown }).message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }
  }
  return "Yaad request failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
