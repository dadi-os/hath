/**
 * Stroke glyphs for devices on the house plan.
 * 18×18, 1.5px stroke, currentColor — the same line as the home icon.
 */

import type { GharCapabilityName } from "../../../shared/api/types";

/** Which drawing a device gets. Lights share the lamp. */
export type DeviceGlyphKind = "lamp" | "lock" | "sensor" | "thermostat" | "speaker";

/** Pick a glyph from capabilities. A light wins over the other clusters on the same endpoint. */
export function glyphFor(
  capabilities: ReadonlyArray<{ capability: GharCapabilityName }>,
): DeviceGlyphKind {
  const names = new Set(capabilities.map((cap) => cap.capability));
  if (names.has("switchable") || names.has("dimmable") || names.has("colorable")) {
    return "lamp";
  }
  if (names.has("lockable")) {
    return "lock";
  }
  if (names.has("thermostat")) {
    return "thermostat";
  }
  if (names.has("media")) {
    return "speaker";
  }
  return "sensor";
}

export type DeviceGlyphProps = {
  kind: DeviceGlyphKind;
  /** Sage fill on a lamp that is on. */
  lit: boolean;
};

/** One device mark. Color comes from the node around it. */
export function DeviceGlyph({ kind, lit }: DeviceGlyphProps) {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden className="size-[18px] shrink-0">
      {kind === "lamp" ? <Lamp lit={lit} /> : null}
      {kind === "lock" ? <Lock /> : null}
      {kind === "sensor" ? <Sensor /> : null}
      {kind === "thermostat" ? <Thermostat /> : null}
      {kind === "speaker" ? <Speaker /> : null}
    </svg>
  );
}

function Lamp({ lit }: { lit: boolean }) {
  return (
    <>
      <path
        d="M5.2 8.4 9 3.2l3.8 5.2H5.2Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill={lit ? "currentColor" : "none"}
        fillOpacity={lit ? 0.22 : 0}
      />
      <path
        d="M9 8.4V12.6M6.3 14.6h5.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  );
}

function Lock() {
  return (
    <>
      <rect
        x="4.6"
        y="8"
        width="8.8"
        height="6.4"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M6.6 8V6.3a2.4 2.4 0 0 1 4.8 0V8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  );
}

function Sensor() {
  return (
    <>
      <circle cx="9" cy="9" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M9 2.8v1.7M9 13.5v1.7M2.8 9h1.7M13.5 9h1.7M4.4 4.4l1.2 1.2M12.4 12.4l1.2 1.2M13.6 4.4l-1.2 1.2M5.6 12.4l-1.2 1.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  );
}

function Thermostat() {
  return (
    <>
      <circle cx="9" cy="9" r="5.2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M9 9.2 11.4 6.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="9" cy="9.2" r="0.9" fill="currentColor" />
    </>
  );
}

function Speaker() {
  return (
    <path
      d="M3.8 7.1h2.4l4-2.4v8.6l-4-2.4H3.8V7.1Z M12.2 7.2c.8.7.8 2.9 0 3.6M13.8 5.6c1.5 1.3 1.5 5.5 0 6.8"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  );
}
