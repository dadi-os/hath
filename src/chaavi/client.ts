/** HTTP client for Chaavi: vault lookup, login and secret saves, and decrypt for fills. */

import axios, { type AxiosInstance } from "axios";
import { z } from "zod";
import type { Config } from "../config.js";
import { CHAAVI_BASE_URL } from "../constants.js";
import { HathError } from "../errors.js";

const itemType = z.enum(["login", "note", "card", "identity", "sshKey", "bankAccount", "driversLicense", "passport"]);

const fieldSchema = z.discriminatedUnion("type", [
  z.object({ name: z.string(), type: z.literal("text"), value: z.string() }),
  z.object({ name: z.string(), type: z.literal("hidden"), hasValue: z.boolean() }),
  z.object({ name: z.string(), type: z.literal("boolean"), value: z.boolean() }),
  z.object({ name: z.string(), type: z.literal("linked"), linkedTo: z.string() }),
]);

const optionalText = z.string().nullable();

const itemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    type: itemType,
    folderId: z.string().nullable(),
    hasNotes: z.boolean(),
    fields: z.array(fieldSchema),
    login: z
      .object({
        username: optionalText,
        uris: z.array(z.object({ uri: z.string() }).passthrough()),
        passkeys: z.array(z.object({ rpId: z.string() }).passthrough()),
      })
      .passthrough()
      .optional(),
    card: z.object({ brand: optionalText }).passthrough().optional(),
    identity: z
      .object({
        firstName: optionalText,
        lastName: optionalText,
        address1: optionalText,
        address2: optionalText,
        city: optionalText,
        state: optionalText,
        postalCode: optionalText,
        country: optionalText,
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const foldersResponseSchema = z
  .object({
    folders: z.array(z.object({ id: z.string().min(1), name: z.string() }).passthrough()),
  })
  .passthrough();

export type ChaaviFolder = z.infer<typeof foldersResponseSchema>["folders"][number];

const itemsResponseSchema = z
  .object({
    items: z.array(itemSchema),
  })
  .passthrough();

const loginResponseSchema = z
  .object({
    username: z.string().nullable(),
    password: z.string(),
  })
  .passthrough();

const cardResponseSchema = z
  .object({
    cardholderName: optionalText,
    brand: optionalText,
    number: z.string().min(1),
    expMonth: optionalText,
    expYear: optionalText,
    code: optionalText,
  })
  .passthrough();

const secretResponseSchema = z
  .object({
    value: z.string().min(1),
  })
  .passthrough();

const savedSecretSchema = z
  .object({
    item: itemSchema,
    created: z.boolean(),
  })
  .passthrough();

const passkeyResponseSchema = z
  .object({
    credentialId: z.string().min(1),
    rpId: z.string().min(1),
    privateKey: z.string().min(1),
    userHandle: z.string(),
    signCount: z.number().int().nonnegative(),
    resident: z.boolean(),
  })
  .passthrough();

export type ChaaviItemType = z.infer<typeof itemType>;
export type ChaaviItem = z.infer<typeof itemSchema>;
export type ChaaviLogin = z.infer<typeof loginResponseSchema>;
export type ChaaviCard = z.infer<typeof cardResponseSchema>;
export type ChaaviSecret = z.infer<typeof secretResponseSchema>;
export type ChaaviSavedSecret = z.infer<typeof savedSecretSchema>;
export type ChaaviPasskey = z.infer<typeof passkeyResponseSchema>;

export type ListItemsRequest = {
  q?: string;
  uri?: string;
  type?: ChaaviItemType;
  /** A folder name; Chaavi takes the items in it and in every folder nested under it. */
  folder?: string;
};

/** A new login; Chaavi generates the password when `password` is omitted. */
export type CreateLoginRequest = {
  name: string;
  username: string;
  uri?: string;
  password?: string;
  length?: number;
  special?: boolean;
};

/** One secret to decrypt from an item (`POST /v1/items/:id/reveal`). */
export type RevealRequest = { field: "notes" | "password" | "number" | "code" } | { field: "custom"; name: string };

/** Value and optional notes for `PUT /v1/secrets/:name`. */
export type SaveSecretRequest = {
  value: string;
  notes?: string;
};

/** Chaavi surface used by agent tools. Secrets stay off the model-visible path. */
export type ChaaviClient = {
  listItems: (query?: ListItemsRequest) => Promise<{ items: ChaaviItem[] }>;
  listFolders: () => Promise<{ folders: ChaaviFolder[] }>;
  getItem: (itemId: string) => Promise<ChaaviItem>;
  createLogin: (input: CreateLoginRequest) => Promise<ChaaviItem>;
  reveal: (itemId: string, request: RevealRequest) => Promise<ChaaviSecret>;
  getLogin: (itemId: string) => Promise<ChaaviLogin>;
  getCard: (itemId: string) => Promise<ChaaviCard>;
  getPasskey: (itemId: string) => Promise<ChaaviPasskey>;
  saveSecret: (name: string, input: SaveSecretRequest) => Promise<ChaaviSavedSecret>;
  revealSecret: (name: string) => Promise<ChaaviSecret>;
};

/** Build a retrying axios client pointed at `CHAAVI_BASE_URL`. */
export function createChaaviClient(config: Config): ChaaviClient {
  const http: AxiosInstance = axios.create({
    baseURL: CHAAVI_BASE_URL,
    timeout: config.chaavi.timeout_ms,
    headers: { "content-type": "application/json" },
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

  async function post<T>(path: string, schema: z.ZodType<T>, body: unknown = {}): Promise<T> {
    const data = await withRetry(config, () => http.post(path, body).then((res) => res.data));
    return parseResponse(schema, data);
  }

  async function put<T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
    const data = await withRetry(config, () => http.put(path, body).then((res) => res.data));
    return parseResponse(schema, data);
  }

  const item = (itemId: string) => `/v1/items/${encodeURIComponent(itemId)}`;
  const secret = (name: string) => `/v1/secrets/${encodeURIComponent(name)}`;

  return {
    listItems: (query = {}) => get("/v1/items", itemsResponseSchema, omitUndefined(query)),
    listFolders: () => get("/v1/folders", foldersResponseSchema),
    getItem: (itemId) => get(item(itemId), itemSchema),
    createLogin: (input) =>
      post("/v1/items", itemSchema, {
        type: "login",
        name: input.name,
        login: omitUndefined({
          username: input.username,
          password: input.password,
          uris: input.uri !== undefined ? [{ uri: input.uri }] : undefined,
          length: input.length,
          special: input.special,
        }),
      }),
    reveal: (itemId, request) => post(`${item(itemId)}/reveal`, secretResponseSchema, request),
    getLogin: (itemId) => post(`${item(itemId)}/login`, loginResponseSchema),
    getCard: (itemId) => post(`${item(itemId)}/card`, cardResponseSchema),
    getPasskey: (itemId) => post(`${item(itemId)}/passkey`, passkeyResponseSchema),
    saveSecret: (name, input) => put(secret(name), savedSecretSchema, omitUndefined(input)),
    revealSecret: (name) => post(`${secret(name)}/reveal`, secretResponseSchema),
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
    throw new HathError(502, "chaavi", "Chaavi response is malformed");
  }
  return parsed.data;
}

async function withRetry(config: Config, fn: () => Promise<unknown>): Promise<unknown> {
  const { retry_attempts: attempts, backoff_ms: backoff } = config.chaavi;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) {
        throw mapChaaviError(err);
      }
    }
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    if (delay === undefined) {
      throw mapChaaviError(lastError);
    }
    await sleep(delay);
  }
  throw mapChaaviError(lastError);
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

const PASSTHROUGH_TYPES = new Set([
  "vault_unconfigured",
  "vault_unreachable",
  "not_found",
  "invalid_request",
  "conflict",
  "internal_error",
]);

function mapChaaviError(err: unknown): HathError {
  if (err instanceof HathError) {
    return err;
  }
  if (axios.isAxiosError(err)) {
    if (!err.response) {
      return new HathError(502, "chaavi", "Chaavi is unreachable");
    }
    const status = err.response.status;
    const { type, message } = chaaviErrorParts(err.response.data);
    if (PASSTHROUGH_TYPES.has(type)) {
      return new HathError(status, type, message);
    }
    if (status >= 400 && status < 500) {
      return new HathError(status, "chaavi", message);
    }
    return new HathError(502, "chaavi", `Chaavi failed: ${message}`);
  }
  return new HathError(502, "chaavi", "Chaavi request failed");
}

function chaaviErrorParts(data: unknown): { type: string; message: string } {
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const type =
        "type" in error && typeof (error as { type: unknown }).type === "string"
          ? (error as { type: string }).type
          : "chaavi";
      const message =
        "message" in error &&
        typeof (error as { message: unknown }).message === "string" &&
        (error as { message: string }).message.length > 0
          ? (error as { message: string }).message
          : "Chaavi request failed";
      return { type, message };
    }
  }
  return { type: "chaavi", message: "Chaavi request failed" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
