import { createChaaviClient, type ChaaviClient } from "./chaavi";
import { createDimaagClient, type DimaagClient } from "./dimaag";
import { createGharClient, type GharClient } from "./ghar";
import { createNasClient, type NasClient } from "./nas";
import { CHAAVI, DIMAAG, GHAR, NAS, YAAD } from "./constants";
import { BrowserTransport } from "./browser-transport";
import { selectTransportKind } from "./runtime";
import type { Transport } from "./transport";
import { createYaadClient, type YaadClient } from "./yaad";

export { createChaaviClient, type ChaaviClient } from "./chaavi";
export { createGharClient, type GharClient } from "./ghar";
export {
  CHAAVI as CHAAVI_URL,
  DIMAAG as DIMAAG_URL,
  YAAD as YAAD_URL,
  NAS as NAS_URL,
  GHAR as GHAR_URL,
} from "./constants";
export { CHAAVI, DIMAAG, YAAD, NAS, GHAR } from "./constants";
export { isTauriRuntime, selectTransportKind } from "./runtime";
export type { TransportKind } from "./runtime";
export type { Transport, ConnectionState } from "./transport";

/** Singleton transport — set by {@link initApi} before the app mounts. */
export let transport!: Transport;

/** True when the dadiMesh (Tauri) transport is active. */
export let usingTsnet = false;

/** Shared Dimaag client bound to {@link DIMAAG} and {@link transport}. */
export let dimaag!: DimaagClient;

/** Shared Yaad client bound to {@link YAAD} and {@link transport}. */
export let yaad!: YaadClient;

/** Shared Nas client bound to {@link NAS} and {@link transport}. */
export let nas!: NasClient;

/** Shared Chaavi client bound to {@link CHAAVI} and {@link transport}. */
export let chaavi!: ChaaviClient;

/** Shared Ghar client bound to {@link GHAR} and {@link transport}. */
export let ghar!: GharClient;

/**
 * Select and wire the Transport + domain clients.
 * MeshTransport (and Rust invoke) load only when Tauri is present so they stay out of
 * the browser entry chunk.
 */
export async function initApi(): Promise<void> {
  if (selectTransportKind() === "tsnet") {
    const { MeshTransport } = await import("./tsnet-transport");
    transport = new MeshTransport();
    usingTsnet = true;
  } else {
    transport = new BrowserTransport();
    usingTsnet = false;
  }
  dimaag = createDimaagClient(transport, DIMAAG);
  yaad = createYaadClient(transport, YAAD);
  nas = createNasClient(transport, NAS);
  chaavi = createChaaviClient(transport, CHAAVI);
  ghar = createGharClient(transport, GHAR);
}
