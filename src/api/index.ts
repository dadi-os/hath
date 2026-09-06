import { createDimaagClient } from "./dimaag";
import { HttpTransport } from "./http-transport";
import type { Transport } from "./transport";
import { createYaadClient } from "./yaad";

export const DIMAAG_URL: string =
  import.meta.env.DIMAAG_URL ?? "http://localhost:8091";
export const YAAD_URL: string =
  import.meta.env.YAAD_URL ?? "http://localhost:8090";

/** Singleton transport — swap the implementation for tsnet without touching callers. */
export const transport: Transport = new HttpTransport();

export const dimaag = createDimaagClient(transport, DIMAAG_URL);
export const yaad = createYaadClient(transport, YAAD_URL);
