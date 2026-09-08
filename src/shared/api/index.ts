import { createDimaagClient, type DimaagClient } from "./dimaag";
import { createNasClient, type NasClient } from "./nas";
import { DIMAAG, NAS, YAAD } from "./constants";
import { BrowserTransport } from "./browser-transport";
import { selectTransportKind } from "./runtime";
import type { Transport } from "./transport";
import { createYaadClient, type YaadClient } from "./yaad";

export { DIMAAG as DIMAAG_URL, YAAD as YAAD_URL, NAS as NAS_URL } from "./constants";
export { DIMAAG, YAAD, NAS } from "./constants";
export { isTauriRuntime, selectTransportKind } from "./runtime";
export type { TransportKind } from "./runtime";
export type { Transport, ConnectionState } from "./transport";

/** Singleton transport — set by {@link initApi} before the app mounts. */
export let transport!: Transport;

/** True when the embedded tsnet transport is active. */
export let usingTsnet = false;

/** Shared Dimaag client bound to {@link DIMAAG} and {@link transport}. */
export let dimaag!: DimaagClient;

/** Shared Yaad client bound to {@link YAAD} and {@link transport}. */
export let yaad!: YaadClient;

/** Shared Nas client bound to {@link NAS} and {@link transport}. */
export let nas!: NasClient;

/**
 * Select and wire the Transport + domain clients.
 * Tsnet (and Rust invoke) load only when Tauri is present so they stay out of
 * the browser entry chunk.
 */
export async function initApi(): Promise<void> {
  if (selectTransportKind() === "tsnet") {
    const { TsnetTransport } = await import("./tsnet-transport");
    transport = new TsnetTransport();
    usingTsnet = true;
  } else {
    transport = new BrowserTransport();
    usingTsnet = false;
  }
  dimaag = createDimaagClient(transport, DIMAAG);
  yaad = createYaadClient(transport, YAAD);
  nas = createNasClient(transport, NAS);
}
