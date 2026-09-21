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
};

/**
 * Host strip for an open agent thread. A terminal command, when present,
 * is the caption. With a browser, the strip floats over the thread.
 */
export function HostPin({ browserId, terminal, floating = false }: HostPinProps) {
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
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
        <span className="host-pin__live" aria-hidden />
        <span
          className={`min-w-0 flex-1 truncate text-[11px] ${
            terminal ? "font-mono text-ink-muted" : "tracking-[0.12em] text-sage-text uppercase"
          }`}
          title={caption}
        >
          {caption}
        </span>
      </div>
      {browserId !== null ? (
        <BrowserFrame browserId={browserId} variant="rail" />
      ) : null}
    </div>
  );

  if (!floating) {
    return <div className="shrink-0 px-3 pb-1 pt-2.5">{pin}</div>;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
      <div className="host-pin-fade" aria-hidden />
      <div className="relative z-10 px-3 pt-2.5">{pin}</div>
    </div>
  );
}
