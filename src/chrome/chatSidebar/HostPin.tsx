import { BrowserFrame } from "../../features/agents/BrowserFrame";

export type HostPinProps = {
  /** Live Nas browser to pin, or null when this agent has none. */
  browserId: number | null;
  /** Live terminal caption, or null. */
  terminal: { id: string; last_command: string | null } | null;
};

/**
 * Host strip above an open agent thread. A terminal command, when present,
 * is the caption; a live browser frame sits inset in the glass card. The
 * strip is in layout (the thread scrolls beneath it, not behind it) and reads
 * as floating through its shadow and the thread's top dissolve.
 */
export function HostPin({ browserId, terminal }: HostPinProps) {
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

  return (
    <div className="relative z-10 shrink-0 px-3 pb-1 pt-3">
      <div className="host-pin">
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
    </div>
  );
}
