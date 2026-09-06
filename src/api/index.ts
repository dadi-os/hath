import { createDimaagClient } from "./dimaag";
import { HttpTransport } from "./http-transport";
import { TsnetTransport } from "./tsnet-transport";
import type { Transport } from "./transport";
import { createYaadClient } from "./yaad";
import { HATH_TARGET } from "../target";

const useTsnet =
  HATH_TARGET === "mobile" || import.meta.env.HATH_TSNET === "1";

function requireUrl(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/** When tsnet is active these must be MagicDNS names (e.g. http://dimaag:8080). */
export const DIMAAG_URL: string = useTsnet
  ? requireUrl("DIMAAG_URL", import.meta.env.DIMAAG_URL)
  : (import.meta.env.DIMAAG_URL ?? "http://localhost:8091");

export const YAAD_URL: string = useTsnet
  ? requireUrl("YAAD_URL", import.meta.env.YAAD_URL)
  : (import.meta.env.YAAD_URL ?? "http://localhost:8090");

/** Singleton transport — HttpTransport for local Docker; TsnetTransport on mobile / HATH_TSNET=1. */
export const transport: Transport = useTsnet
  ? new TsnetTransport()
  : new HttpTransport();

export const usingTsnet = useTsnet;

export const dimaag = createDimaagClient(transport, DIMAAG_URL);
export const yaad = createYaadClient(transport, YAAD_URL);
