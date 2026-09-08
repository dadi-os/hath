import { createDimaagClient } from "./dimaag";
import { createNasClient } from "./nas";
import { DIMAAG, NAS, YAAD } from "./constants";
import { TsnetTransport } from "./tsnet-transport";
import { createYaadClient } from "./yaad";

export { DIMAAG as DIMAAG_URL, YAAD as YAAD_URL, NAS as NAS_URL } from "./constants";
export { DIMAAG, YAAD, NAS } from "./constants";

/** Singleton transport — embedded tsnet for every target. */
export const transport = new TsnetTransport();

/** Always true in this shell; mesh dials go through {@link transport}. */
export const usingTsnet = true;

/** Shared Dimaag client bound to {@link DIMAAG} and {@link transport}. */
export const dimaag = createDimaagClient(transport, DIMAAG);

/** Shared Yaad client bound to {@link YAAD} and {@link transport}. */
export const yaad = createYaadClient(transport, YAAD);

/** Shared Nas client bound to {@link NAS} and {@link transport}. */
export const nas = createNasClient(transport, NAS);
