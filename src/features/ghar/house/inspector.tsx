/**
 * Hover popover for one device: name, identify, brightness, and color.
 * Power stays on the card. Values stay at the last confirmed reading until Ghar accepts.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import type { GharDevice } from "../../../shared/api/types";
import { Popover, type PopoverAnchor } from "../../../shared/components/Popover";

export type DevicePopoverProps = {
  device: GharDevice;
  open: boolean;
  anchor: PopoverAnchor;
  containerRef: RefObject<HTMLElement | null>;
  /** A command for this device is in flight. Controls wait in gray. */
  pending: boolean;
  onClose: () => void;
  /** Pointer entered the panel, so a hover-close should wait. */
  onHoverStart: () => void;
  /** Pointer left the panel. */
  onHoverEnd: () => void;
  onRename: (name: string) => void;
  onIdentify: () => void;
  onBrightness: (level: number) => void;
  onHue: (hue: number, saturation: number) => void;
  onColorTemp: (mireds: number) => void;
};

const field =
  "w-full border-b border-sage-line bg-transparent text-[15px] text-ink outline-none transition-colors duration-slow ease-hath placeholder:text-ink-ghost hover:border-sage focus:border-sage";

const thumb =
  "h-2 w-full cursor-pointer appearance-none rounded-full disabled:cursor-default disabled:opacity-50 [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-sage [&::-webkit-slider-thumb]:bg-bone [&::-webkit-slider-thumb]:shadow-[var(--shadow)]";

/** Matter hue 0–254 as a CSS hue in degrees. */
function hueDeg(matterHue: number): number {
  return Math.round((matterHue / 254) * 360);
}

/** Matter saturation 0–254 as a CSS percentage. */
function satPct(matterSat: number): number {
  return Math.round((matterSat / 254) * 100);
}

/** Confirmed numeric attribute, or null when Ghar has not reported it. */
function confirmed(device: GharDevice, key: string): number | null {
  const value = device.state[key]?.value;
  return typeof value === "number" ? value : null;
}

function hasCapability(device: GharDevice, name: string): boolean {
  return device.capabilities.some((cap) => cap.capability === name);
}

/** Color modes advertised on the colorable capability. Both, when unset. */
function colorModes(device: GharDevice): Array<"hue_sat" | "color_temp"> {
  const cap = device.capabilities.find((item) => item.capability === "colorable");
  const modes = cap?.config?.modes;
  if (!Array.isArray(modes)) {
    return ["hue_sat", "color_temp"];
  }
  const known = modes.filter(
    (mode): mode is "hue_sat" | "color_temp" => mode === "hue_sat" || mode === "color_temp",
  );
  return known.length > 0 ? known : ["hue_sat", "color_temp"];
}

/**
 * Device detail panel. Uses the shared popover for position and dismiss.
 * Sliders commit on release so a drag is one command.
 */
export function DevicePopover({
  device,
  open,
  anchor,
  containerRef,
  pending,
  onClose,
  onHoverStart,
  onHoverEnd,
  onRename,
  onIdentify,
  onBrightness,
  onHue,
  onColorTemp,
}: DevicePopoverProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(device.name);

  useEffect(() => {
    if (document.activeElement === nameRef.current) {
      return;
    }
    setName(device.name);
  }, [device.id, device.name]);

  const on = device.state.on?.value === true;
  const dimmable = hasCapability(device, "dimmable");
  const modes = hasCapability(device, "colorable") ? colorModes(device) : [];
  const brightness = confirmed(device, "brightness");
  const hue = confirmed(device, "hue");
  const saturation = confirmed(device, "saturation");
  const colorTemp = confirmed(device, "color_temp");
  const swatch =
    hue === null ? null : `hsl(${hueDeg(hue)} ${satPct(saturation ?? 254)}% 52%)`;
  const locked = pending || !device.online;
  const status = !device.online ? "Offline" : pending ? "Waiting" : on ? "On" : "Off";

  function commitName(): void {
    const trimmed = name.trim();
    if (!trimmed || trimmed === device.name) {
      setName(device.name);
      return;
    }
    onRename(trimmed);
  }

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchor={anchor}
      containerRef={containerRef}
      aria-label={`${device.name} controls`}
      widthPx={300}
      caret
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
    >
      <div className="flex flex-col gap-3 px-3.5 py-3">
        <div className="flex items-start gap-3 border-b border-rule/60 pb-2.5">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[10px] font-medium tracking-[0.14em] text-ink-ghost uppercase">
              Name
            </span>
            <input
              ref={nameRef}
              value={name}
              aria-label={`Name of ${device.name}`}
              onChange={(event) => setName(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  setName(device.name);
                  onClose();
                }
              }}
              className={field}
            />
          </label>
          <button
            type="button"
            onClick={onClose}
            className="mt-4 text-[11px] tracking-wide text-ink-ghost hover:text-ink-muted"
          >
            ESC
          </button>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-[12px] text-ink-ghost">
            {device.product_name ? `${device.product_name} · ${status}` : status}
          </span>
          {swatch ? (
            <span
              className="size-4 shrink-0 rounded-full border border-sage-line"
              style={{ background: swatch }}
              aria-hidden
            />
          ) : null}
        </div>

        <button
          type="button"
          disabled={locked}
          onClick={onIdentify}
          className="self-start rounded-full border border-dashed border-sage-line bg-[var(--glass-sheet)] px-3 py-1.5 text-[12px] font-medium tracking-[0.12em] text-sage-deep uppercase transition-[border-color,background-color] duration-slow ease-hath hover:border-sage hover:bg-sage-active/50 disabled:cursor-default disabled:opacity-50"
        >
          Identify
        </button>

      {dimmable ? (
        <RangeControl
          label="Brightness"
          min={0}
          max={100}
          value={brightness ?? 0}
          readout={brightness === null ? "—" : `${Math.round(brightness)}%`}
          pending={pending}
          disabled={!device.online}
          track="linear-gradient(90deg, var(--bone), var(--sage))"
          onCommit={(level) => onBrightness(Math.round(level))}
        />
      ) : null}

      {modes.includes("hue_sat") ? (
        <>
          <RangeControl
            label="Color"
            min={0}
            max={254}
            value={hue ?? 0}
            readout={hue === null ? "—" : `${hueDeg(hue)}°`}
            pending={pending}
            disabled={!device.online}
            track="linear-gradient(90deg, #ff4d4d, #ffd60a, #34c759, #32ade6, #7a5cff, #ff4d4d)"
            onCommit={(next) => onHue(Math.round(next), Math.round(saturation ?? 254))}
          />
          <RangeControl
            label="Saturation"
            min={0}
            max={254}
            value={saturation ?? 254}
            readout={saturation === null ? "—" : `${satPct(saturation)}%`}
            pending={pending}
            disabled={!device.online}
            track={`linear-gradient(90deg, #c8c2b8, ${swatch ?? "var(--sage)"})`}
            onCommit={(next) => onHue(Math.round(hue ?? 0), Math.round(next))}
          />
        </>
      ) : null}

      {modes.includes("color_temp") ? (
        <RangeControl
          label="Temperature"
          min={153}
          max={500}
          value={colorTemp ?? 370}
          readout={colorTemp === null ? "—" : `${Math.round(1_000_000 / colorTemp)}K`}
          pending={pending}
          disabled={!device.online}
          track="linear-gradient(90deg, #d6e6ff, #fff6e4, #ffb15a)"
          onCommit={(mireds) => onColorTemp(Math.round(mireds))}
        />
      ) : null}
      </div>
    </Popover>
  );
}

/**
 * One slider. The thumb tracks the finger; the command fires on release.
 * `readout` stays on the last confirmed value while the drag is local.
 */
function RangeControl({
  label,
  min,
  max,
  value,
  readout,
  pending,
  disabled,
  track,
  onCommit,
}: {
  label: string;
  min: number;
  max: number;
  /** Last confirmed value. */
  value: number;
  readout: string;
  pending: boolean;
  disabled: boolean;
  track: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const drafting = useRef(false);
  const shown = draft ?? value;

  function finish(next: number): void {
    if (!drafting.current) {
      return;
    }
    drafting.current = false;
    setDraft(null);
    if (next !== value) {
      onCommit(next);
    }
  }

  return (
    <label className={`flex flex-col gap-1.5 ${pending ? "opacity-60" : ""}`}>
      <span className="flex items-center justify-between text-[10px] font-medium tracking-[0.14em] text-ink-ghost uppercase">
        <span>{label}</span>
        <span className="normal-case tracking-normal text-ink">
          {draft !== null ? (
            <span className="text-ink-ghost">{Math.round(draft)}</span>
          ) : (
            readout
          )}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={shown}
        disabled={disabled || pending}
        aria-label={label}
        onPointerDown={() => {
          drafting.current = true;
          setDraft(value);
        }}
        onKeyDown={() => {
          drafting.current = true;
        }}
        onChange={(event) => {
          if (drafting.current) {
            setDraft(Number(event.target.value));
          }
        }}
        onPointerUp={(event) => finish(Number(event.currentTarget.value))}
        onKeyUp={(event) => finish(Number(event.currentTarget.value))}
        onBlur={(event) => {
          if (draft !== null) {
            finish(Number(event.currentTarget.value));
          }
        }}
        className={thumb}
        style={{ background: track }}
      />
    </label>
  );
}
