import { useNavigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { nas } from "../shared/api";
import { useConnection } from "../hooks/useConnection";
import { IconButton, IconHome, IconPower } from "../shared/components/IconButton";
import { POLL_MS } from "../shared/lib/ux/poll";
import { Tooltip } from "../shared/components/Tooltip";
import { isTauriRuntime } from "../shared/api/runtime";
import { detectDesktopOs } from "../target";
import { WindowControls } from "./WindowControls";

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

/** Toggle maximize on the current Tauri window; no-op outside the desktop shell. */
function toggleMaximize() {
  if (!isTauriRuntime()) {
    return;
  }
  void getCurrentWindow().toggleMaximize();
}

export type HeaderProps = {
  /** Drag strip + window controls only — first-launch join must not grow a second chrome bar. */
  minimal?: boolean;
};

/** Desktop glass menu bar — brand + mesh status + leave control + window chrome. */
export function Header({ minimal = false }: HeaderProps) {
  const navigate = useNavigate();
  const { state, disconnect } = useConnection();
  const location = useLocation();
  const desktopOs = detectDesktopOs();
  const atHome = location.pathname === "/";
  const frameless = desktopOs === "windows" || desktopOs === "linux";
  const statusLabel =
    state === "connected"
      ? "ONLINE"
      : state === "connecting"
        ? "JOINING…"
        : "OFFLINE";
  const statusClass =
    state === "connected" || state === "connecting"
      ? "text-sage"
      : "text-ink-ghost";

  const statusQuery = useQuery({
    queryKey: ["nas", "status"],
    queryFn: () => nas.getStatus(),
    enabled: state === "connected",
    refetchInterval: POLL_MS,
  });

  const uptime =
    statusQuery.data != null
      ? formatUptime(statusQuery.data.uptime_seconds)
      : state === "connected"
        ? "…"
        : "—";

  const pad =
    desktopOs === "macos"
      ? "pl-[80px] pr-3"
      : frameless
        ? "pl-3 pr-0"
        : "px-4 sm:px-6";

  if (minimal) {
    return (
      <header
        className={`titlebar flex h-12 shrink-0 items-stretch select-none ${
          desktopOs === "macos" ? "pl-[80px] pr-0" : pad
        }`}
      >
        <div
          className="titlebar-drag min-h-0 min-w-[24px] flex-1"
          data-tauri-drag-region
          onDoubleClick={toggleMaximize}
        />
        {frameless ? <WindowControls /> : null}
      </header>
    );
  }

  return (
    <header
      className={`titlebar flex h-12 shrink-0 items-stretch select-none ${pad}`}
    >
      <div className="flex shrink-0 items-center gap-2.5 py-2">
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
          className="flex items-center"
          aria-label="Dadi home"
        >
          <span className="font-gujarati text-[22px] leading-[1.45] text-sage-text">
            દાદી
          </span>
        </button>
      </div>

      <div
        className="titlebar-drag min-h-0 min-w-[24px] flex-1"
        data-tauri-drag-region
        onDoubleClick={toggleMaximize}
      />

      <div
        className={`flex shrink-0 items-center gap-2.5 py-2 ${
          frameless ? "pr-1.5" : ""
        }`}
      >
        {state === "connected" ? (
          <Tooltip content="Leave dadiMesh">
            <span className="inline-flex">
              <IconButton
                label="Leave dadiMesh"
                size="sm"
                onClick={() => {
                  void disconnect();
                }}
              >
                <IconPower />
              </IconButton>
            </span>
          </Tooltip>
        ) : null}
        <div className="flex flex-col items-end gap-0.5 pr-1">
          <span
            className={`text-[10px] font-medium tracking-[2.5px] ${statusClass}`}
          >
            {statusLabel}
          </span>
          <Tooltip
            content={
              statusQuery.data
                ? `Dadi uptime · ${statusQuery.data.uptime_seconds}s`
                : "Dadi uptime"
            }
          >
            <span className="text-[10px] tracking-wide text-ink-ghost">
              {uptime}
            </span>
          </Tooltip>
        </div>
      </div>

      {frameless ? <WindowControls /> : null}
    </header>
  );
}
