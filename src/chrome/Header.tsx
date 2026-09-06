import { useConnection } from "../hooks/useConnection";

export function Header() {
  const { state } = useConnection();
  const statusLabel = state === "connected" ? "ONLINE" : "OFFLINE";
  const statusClass =
    state === "connected"
      ? "text-sage"
      : state === "connecting"
        ? "text-sage animate-breath"
        : "text-ink-ghost";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-rule px-6">
      <div className="flex items-baseline gap-2.5">
        <span className="font-gujarati text-[28px] leading-none text-sage-text">
          દાદી
        </span>
        <span className="text-[11px] font-medium tracking-[2.5px] text-ink-faint">
          DADI
        </span>
      </div>

      <div className="flex flex-col items-end gap-0.5">
        <span
          className={`text-[11px] font-medium tracking-[2.5px] ${statusClass}`}
        >
          {statusLabel}
        </span>
        {/* TODO(nas): replace with real uptime from Nas GET /status when it exists. */}
        <span className="text-[11px] tracking-wide text-ink-ghost">
          —d —h
        </span>
      </div>
    </header>
  );
}
