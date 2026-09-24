import { useLayoutEffect, useRef } from "react";
import { BrowserFrame } from "../../features/agents/BrowserFrame";

export type HostPinProps = {
  /** Live Nas browser to pin, or null when this agent has none. */
  browserId: number | null;
  /** Live terminal caption, or null. */
  terminal: { id: string; last_command: string | null } | null;
  /**
   * Overlay the thread with the same downward dissolve as the composer.
   * Used when a browser frame is present.
   */
  floating?: boolean;
  /** Floating only: reports the pin's height (from the pane top) as it changes. */
  onHeight?: (px: number) => void;
};

/**
 * Host strip for an open agent thread. A terminal command, when present,
 * is the caption. With a browser, the strip floats over the thread and the
 * frame sits inset in the glass card with a matching inner radius.
 */
export function HostPin({
  browserId,
  terminal,
  floating = false,
  onHeight,
}: HostPinProps) {
  const measureRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!floating || !onHeight || !el) {
      return;
    }
    const report = () => onHeight(Math.ceil(el.getBoundingClientRect().height));
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => {
      ro.disconnect();
      onHeight(0);
    };
  }, [floating, onHeight]);

  if (browserId === null && terminal === null) {
    return null;
  }

  const command = terminal?.last_command?.replace(/\s+/g, " ").trim();
  const caption =
    command && command.length > 0
      ? command
      : terminal
        ? terminal.id
        : "Browser";

  const pin = (
    <div className={`host-pin ${floating ? "pointer-events-auto" : ""}`}>
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <span className="host-pin__live" aria-hidden />
        <span
          className={`min-w-0 flex-1 truncate text-[11px] leading-none ${
            terminal ? "font-mono text-ink-muted" : "tracking-[0.12em] text-sage-text uppercase"
          }`}
          title={caption}
        >
          {caption}
        </span>
      </div>
      {browserId !== null ? (
        <div className="px-1.5 pb-1.5">
          <BrowserFrame
            browserId={browserId}
            variant="rail"
            className="rounded-[11px]"
          />
        </div>
      ) : null}
    </div>
  );

  if (!floating) {
    return <div className="shrink-0 px-3 pb-1 pt-3">{pin}</div>;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
      <div className="host-pin-fade" aria-hidden />
      <div ref={measureRef} className="relative z-10 px-3 pt-3">
        {pin}
      </div>
    </div>
  );
}
