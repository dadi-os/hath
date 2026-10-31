/**
 * Topology. Identical in dev and prod — Nas's proxy resolves these names in both.
 * Not configurable, deliberately.
 */
export const DWAR_BASE_URL = "http://dwar.dadi";
export const YAAD_BASE_URL = "http://yaad.dadi";
export const GHAR_BASE_URL = "http://ghar.dadi";
export const NAS = "http://nas.dadi";
export const HOST = "0.0.0.0";
export const PORT = 8080;
export const LOG_LEVEL = "info";

/** How long a control_device call waits for Ghar's run before it goes pending. */
export const CONTROL_WAIT_MS = 8_000;

/** How often a pending control run is read from Ghar. */
export const CONTROL_POLL_MS = 2_000;

/** How long a pending control run is followed before it is reported unfinished. */
export const CONTROL_GIVE_UP_MS = 5 * 60 * 1000;
