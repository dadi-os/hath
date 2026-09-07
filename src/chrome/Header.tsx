import { useNavigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { nas } from "../api";
import { useConnection } from "../hooks/useConnection";
import { IconButton, IconHome } from "../shared/IconButton";
import { Tooltip } from "../shared/Tooltip";

function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

export function Header() {
  const navigate = useNavigate();
  const { state } = useConnection();
  const location = useLocation();
  const atHome = location.pathname === "/";
  const statusLabel = state === "connected" ? "ONLINE" : "OFFLINE";
  const statusClass =
    state === "connected"
      ? "text-sage"
      : state === "connecting"
        ? "text-sage animate-breath"
        : "text-ink-ghost";

  const statusQuery = useQuery({
    queryKey: ["nas", "status"],
    queryFn: () => nas.getStatus(),
    enabled: state === "connected",
    refetchInterval: 30_000,
  });

  const uptime =
    statusQuery.data != null
      ? formatUptime(statusQuery.data.uptime_seconds)
      : state === "connected"
        ? "…"
        : "—";

  return (
    <header className="flex shrink-0 items-center justify-between border-b border-rule px-4 pb-3.5 pt-4 sm:px-6">
      <div className="flex items-center gap-3">
        <Tooltip content={atHome ? "Home" : "Back home"}>
          <span className="inline-flex">
            <IconButton
              label="Home"
              size="sm"
              disabled={atHome}
              onClick={() => navigate("/")}
            >
              <IconHome />
            </IconButton>
          </span>
        </Tooltip>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="flex items-baseline gap-2.5"
          aria-label="Dadi home"
        >
          <span className="font-gujarati text-[28px] leading-none text-sage-text">
            દાદી
          </span>
          <span className="text-[11px] font-medium tracking-[2.5px] text-ink-faint">
            DADI
          </span>
        </button>
      </div>

      <div className="flex flex-col items-end gap-0.5">
        <span
          className={`text-[11px] font-medium tracking-[2.5px] ${statusClass}`}
        >
          {statusLabel}
        </span>
        <Tooltip
          content={
            statusQuery.data
              ? `Box uptime · ${statusQuery.data.uptime_seconds}s`
              : "Box uptime"
          }
        >
          <span className="text-[11px] tracking-wide text-ink-ghost">
            {uptime}
          </span>
        </Tooltip>
      </div>
    </header>
  );
}
