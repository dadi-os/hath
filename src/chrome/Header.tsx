import { PowerIcon } from "./PowerIcon";
import { useConnection } from "../hooks/useConnection";

export function Header() {
  const { state } = useConnection();
  const statusLabel = state === "connected" ? "ONLINE" : "OFFLINE";

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

      <div className="flex items-center gap-4">
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-[11px] font-medium tracking-[2.5px] text-sage">
            {statusLabel}
          </span>
          {/* TODO(chaavi): replace with real uptime from Chaavi when it exists. */}
          <span className="text-[11px] tracking-wide text-ink-ghost">
            —d —h
          </span>
        </div>
        <PowerIcon />
      </div>
    </header>
  );
}
