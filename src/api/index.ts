import { createDimaagClient } from "./dimaag";
import { DIMAAG, YAAD } from "./constants";
import { TsnetTransport } from "./tsnet-transport";
import { createYaadClient } from "./yaad";

export { DIMAAG as DIMAAG_URL, YAAD as YAAD_URL, NAS as NAS_URL } from "./constants";
export { DIMAAG, YAAD, NAS } from "./constants";

/** Singleton transport — embedded tsnet for every target. */
export const transport = new TsnetTransport();

export const usingTsnet = true;

export const dimaag = createDimaagClient(transport, DIMAAG);
export const yaad = createYaadClient(transport, YAAD);
