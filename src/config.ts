/** Typed process config. The only module that reads the environment or config.toml. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import {
  CHAAVI_BASE_URL,
  DWAR_BASE_URL,
  GHAR_BASE_URL,
  HOST,
  LOG_LEVEL,
  NAS,
  PORT,
  YAAD_BASE_URL,
} from "./constants.js";

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tomlPath = join(serviceRoot, "config.toml");

const fileSchema = z.object({
  runtime: z.object({
    lane_queue_timeout_ms: z.number().int().positive(),
    transcript_window_messages: z.number().int().positive(),
    transcript_window_step_messages: z.number().int().positive(),
    tool_debounce_base_ms: z.number().int().positive(),
    tool_debounce_max_ms: z.number().int().positive(),
    wake_tool_results_max_chars: z.number().int().positive(),
    wake_tool_results_kept_chars: z.number().int().positive(),
  }).refine((runtime) => runtime.wake_tool_results_kept_chars < runtime.wake_tool_results_max_chars, {
    message: "wake_tool_results_kept_chars must be below wake_tool_results_max_chars",
  }),
  dwar: z.object({
    timeout_ms: z.number().int().positive(),
    retry_attempts: z.number().int().positive(),
    backoff_ms: z.array(z.number().min(0)).nonempty(),
  }),
  yaad: z.object({
    timeout_ms: z.number().int().positive(),
    retry_attempts: z.number().int().positive(),
    backoff_ms: z.array(z.number().min(0)).nonempty(),
  }),
  ghar: z.object({
    timeout_ms: z.number().int().positive(),
    retry_attempts: z.number().int().positive(),
    backoff_ms: z.array(z.number().min(0)).nonempty(),
  }),
  chaavi: z.object({
    timeout_ms: z.number().int().positive(),
    retry_attempts: z.number().int().positive(),
    backoff_ms: z.array(z.number().min(0)).nonempty(),
  }),
  nas: z.object({
    timeout_ms: z.number().int().positive(),
    retry_attempts: z.number().int().positive(),
    backoff_ms: z.array(z.number().min(0)).nonempty(),
  }),
  devices: z.object({
    timeout_ms: z.number().int().positive(),
  }),
  browser: z.object({
    action_timeout_ms: z.number().int().positive(),
    navigation_timeout_ms: z.number().int().positive(),
    snapshot_max_bytes: z.number().int().positive(),
  }),
  schedule: z.object({
    tick_seconds: z.number().int().positive(),
  }),
});

export type FileConfig = z.infer<typeof fileSchema>;

export type Config = {
  serviceRoot: string;
  env: {
    databaseUrl: string;
    /** The box's IANA zone from `TZ`, which also sets this process's local time. */
    timezone: string;
    dwarBaseUrl: string;
    yaadBaseUrl: string;
    gharBaseUrl: string;
    chaaviBaseUrl: string;
    nasBaseUrl: string;
    host: string;
    port: number;
    logLevel: typeof LOG_LEVEL;
  };
  runtime: FileConfig["runtime"];
  dwar: FileConfig["dwar"];
  yaad: FileConfig["yaad"];
  ghar: FileConfig["ghar"];
  chaavi: FileConfig["chaavi"];
  nas: FileConfig["nas"];
  devices: FileConfig["devices"];
  browser: FileConfig["browser"];
  schedule: FileConfig["schedule"];
};

export function loadFileConfig(): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(tomlPath, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read config file ${tomlPath}: ${reason}`, { cause: err });
  }
  const parsed = fileSchema.safeParse(parseToml(raw));
  if (!parsed.success) {
    throw new Error(`invalid config.toml: ${parsed.error.message}`);
  }
  return parsed.data;
}

let cached: Config | undefined;

/** Clear the memoized config (tests only). */
export function resetConfigCache(): void {
  cached = undefined;
}

/**
 * Load process config from config.toml and required env.
 * @throws When config.toml is invalid, DATABASE_URL is missing, or TZ is missing or not an IANA zone.
 */
export function loadConfig(): Config {
  if (cached) {
    return cached;
  }
  const file = loadFileConfig();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const timezone = process.env.TZ;
  if (!timezone) {
    throw new Error("TZ is required");
  }
  if (!Intl.supportedValuesOf("timeZone").includes(timezone)) {
    throw new Error(`TZ is not an IANA time zone: ${timezone}`);
  }
  cached = {
    serviceRoot,
    env: {
      databaseUrl,
      timezone,
      dwarBaseUrl: DWAR_BASE_URL,
      yaadBaseUrl: YAAD_BASE_URL,
      gharBaseUrl: GHAR_BASE_URL,
      chaaviBaseUrl: CHAAVI_BASE_URL,
      nasBaseUrl: NAS,
      host: HOST,
      port: PORT,
      logLevel: LOG_LEVEL,
    },
    runtime: file.runtime,
    dwar: file.dwar,
    yaad: file.yaad,
    ghar: file.ghar,
    chaavi: file.chaavi,
    nas: file.nas,
    devices: file.devices,
    browser: file.browser,
    schedule: file.schedule,
  };
  return cached;
}
