/** HTTP client for Dwar chat (the work lane / the process lane / complete) and image describe. */

import axios, { type AxiosInstance } from "axios";
import { z } from "zod";
import type { Config } from "../config.js";
import { DWAR_BASE_URL } from "../constants.js";
import { HathError } from "../errors.js";
import type { DwarChatRequest, DwarChatResponse, DwarUsage } from "../types/domain.js";

const chatBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    thought_signature: z.string().nullish(),
  }),
  z.object({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string().nullish(),
  }),
  z.object({ type: z.literal("redacted_thinking"), data: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
    thought_signature: z.string().nullish(),
  }),
]);

const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_input_tokens: z.number(),
  cache_creation_input_tokens: z.number(),
});

const chatResponseSchema = z.object({
  provider: z.enum(["anthropic", "gemini"]),
  content: z.array(chatBlockSchema),
  stop_reason: z.enum(["end_turn", "tool_use", "max_tokens", "error"]),
  usage: usageSchema,
});

const describeResponseSchema = z.object({
  description: z.string().min(1),
  usage: usageSchema,
});

export type DwarDescribeImageRequest = {
  image: { media_type: string; data: string };
  prompt?: string;
};

export type DwarDescribeImageResponse = {
  description: string;
  usage: DwarUsage;
};

/**
 * Dwar surface used by Hath: lane chat, promptless complete, and image captioning.
 * `caller` is sent as X-Dadi-Caller (`hath/<agent id>`, `hath/router`, …) so Dwar's
 * inference log attributes each call's tokens to whoever spent them.
 */
export type DwarClient = {
  work: (request: DwarChatRequest, caller: string) => Promise<DwarChatResponse>;
  process: (request: DwarChatRequest, caller: string) => Promise<DwarChatResponse>;
  complete: (request: DwarChatRequest, caller: string) => Promise<DwarChatResponse>;
  describeImage: (
    request: DwarDescribeImageRequest,
    caller: string,
  ) => Promise<DwarDescribeImageResponse>;
  webSearch: (request: DwarWebSearchRequest, caller: string) => Promise<DwarWebSearchResponse>;
  webFetch: (request: DwarWebFetchRequest, caller: string) => Promise<DwarWebFetchResponse>;
};

export type DwarWebSearchRequest = {
  query: string;
  max_results?: number | undefined;
  allowed_domains?: string[] | undefined;
  blocked_domains?: string[] | undefined;
};

const webSearchResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      page_age: z.string().nullable().optional(),
      about: z.string().nullable().optional(),
    }),
  ),
  searches: z.number(),
});
export type DwarWebSearchResponse = z.infer<typeof webSearchResponseSchema>;

export type DwarWebFetchRequest = { urls: string[]; question?: string | undefined };

const webFetchResponseSchema = z.object({
  pages: z.array(
    z.object({
      url: z.string(),
      final_url: z.string(),
      status: z.number().nullable(),
      title: z.string(),
      text: z.string(),
      error: z.string().nullable(),
      answer: z.string().nullable().optional(),
    }),
  ),
});
export type DwarWebFetchResponse = z.infer<typeof webFetchResponseSchema>;

/** Build a retrying axios client pointed at `DWAR_BASE_URL`. */
export function createDwarClient(config: Config): DwarClient {
  const http: AxiosInstance = axios.create({
    baseURL: DWAR_BASE_URL,
    timeout: config.dwar.timeout_ms,
    headers: { "content-type": "application/json" },
  });

  async function postChat(
    path: string,
    request: DwarChatRequest,
    caller: string,
  ): Promise<DwarChatResponse> {
    const data = await withRetry(config, () =>
      http.post(path, request, { headers: { "x-dadi-caller": caller } }).then((res) => res.data),
    );
    const parsed = chatResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new HathError(502, "dwar", "Dwar chat response is malformed");
    }
    return parsed.data;
  }

  async function describeImage(
    request: DwarDescribeImageRequest,
    caller: string,
  ): Promise<DwarDescribeImageResponse> {
    const body: Record<string, unknown> = { image: request.image };
    if (request.prompt !== undefined) {
      body.prompt = request.prompt;
    }
    const data = await withRetry(config, () =>
      http
        .post("/image/describe", body, { headers: { "x-dadi-caller": caller } })
        .then((res) => res.data),
    );
    const parsed = describeResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new HathError(502, "dwar", "Dwar image describe response is malformed");
    }
    return parsed.data;
  }

  async function postWeb<T>(path: string, body: unknown, caller: string, schema: z.ZodType<T>): Promise<T> {
    const data = await withRetry(config, () =>
      http.post(path, body, { headers: { "x-dadi-caller": caller } }).then((res) => res.data),
    );
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new HathError(502, "dwar", `Dwar ${path} response is malformed`);
    }
    return parsed.data;
  }

  return {
    webSearch: (request, caller) => postWeb("/web/search", request, caller, webSearchResponseSchema),
    webFetch: (request, caller) => postWeb("/web/fetch", request, caller, webFetchResponseSchema),
    work: (request, caller) => postChat("/chat/work", request, caller),
    process: (request, caller) => postChat("/chat/process", request, caller),
    complete: (request, caller) => postChat("/chat/complete", request, caller),
    describeImage,
  };
}

async function withRetry(config: Config, fn: () => Promise<unknown>): Promise<unknown> {
  const { retry_attempts: attempts, backoff_ms: backoff } = config.dwar;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) {
        throw mapDwarError(err);
      }
      const delay = backoff[Math.min(attempt, backoff.length - 1)];
      if (delay === undefined) {
        throw mapDwarError(err);
      }
      await sleep(delay);
    }
  }
  throw mapDwarError(lastError);
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

function mapDwarError(err: unknown): HathError {
  if (err instanceof HathError) {
    return err;
  }
  if (axios.isAxiosError(err)) {
    if (!err.response) {
      return new HathError(502, "upstream_unreachable", "Dwar is unreachable");
    }
    const message = dwarMessage(err.response.data);
    return new HathError(502, "dwar", message);
  }
  return new HathError(502, "dwar", "Dwar request failed");
}

function dwarMessage(data: unknown): string {
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error: unknown }).error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message: unknown }).message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }
  }
  return "Dwar request failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
