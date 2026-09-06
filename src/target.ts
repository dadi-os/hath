export type HathTarget = "kiosk" | "desktop" | "mobile";

const raw = import.meta.env.HATH_TARGET ?? "desktop";

function parseTarget(value: string): HathTarget {
  if (value === "kiosk" || value === "desktop" || value === "mobile") {
    return value;
  }
  throw new Error(
    `Invalid HATH_TARGET "${value}". Expected kiosk, desktop, or mobile.`,
  );
}

/** Build-time target. Do not infer from viewport width. */
export const HATH_TARGET: HathTarget = parseTarget(raw);
