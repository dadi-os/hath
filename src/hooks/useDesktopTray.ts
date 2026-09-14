import { useEffect, useEffectEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { dimaag, nas } from "../shared/api";
import { useConnection } from "./useConnection";
import { useDesktopUpdate } from "./useDesktopUpdate";
import { useTarget } from "./useTarget";
import { AGENTS_QUERY_KEY } from "./useEvents";
import {
  formatDiskLabel,
  syncDesktopTray,
  type TrayListState,
  type TraySnapshot,
} from "../shared/desktop/tray";
import { logLine } from "../shared/lib/platform/log";
import { openAgent } from "../store/chat";
import { subscribeDesktopShell } from "../store/desktopShell";
import { POLL_MS } from "../shared/lib/ux/poll";

const TRAY_REFRESH_MS = 5_000;

/**
 * Map a React Query result into an explicit tray list state (no silent empty arrays).
 */
function trayListState<T>(query: {
  isError: boolean;
  isSuccess: boolean;
  data: T[] | undefined;
}): TrayListState<T> {
  if (query.isError) {
    return { status: "error" };
  }
  if (query.isSuccess && query.data !== undefined) {
    return { status: "ready", items: query.data };
  }
  return { status: "pending" };
}

/**
 * Own the desktop tray + macOS app menu. No-op on browser / mobile.
 * Also routes tray actions into navigation, chat, mesh, and updates.
 */
export function useDesktopTray(opts: {
  /** Open the provision client modal. */
  onProvision: () => void;
}): void {
  const target = useTarget();
  const navigate = useNavigate();
  const { state, disconnect } = useConnection();
  const update = useDesktopUpdate();

  const onProvision = useEffectEvent(opts.onProvision);
  const installUpdate = useEffectEvent(() => {
    void update.install();
  });
  const leaveMesh = useEffectEvent(() => {
    void disconnect();
  });

  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: async () => {
      const { agents } = await dimaag.listAgents();
      return agents;
    },
    enabled: target === "desktop" && state === "connected",
    refetchInterval: TRAY_REFRESH_MS,
  });

  const statusQuery = useQuery({
    queryKey: ["nas", "status", "tray"],
    queryFn: () => nas.getStatus(),
    enabled: target === "desktop" && state === "connected",
    refetchInterval: POLL_MS,
  });

  const browsersQuery = useQuery({
    queryKey: ["nas", "browsers", "tray"],
    queryFn: () => nas.listBrowsers(),
    enabled: target === "desktop" && state === "connected",
    refetchInterval: TRAY_REFRESH_MS,
  });

  useEffect(() => {
    if (target !== "desktop") {
      return;
    }

    return subscribeDesktopShell((action) => {
      switch (action.type) {
        case "show_window":
          break;
        case "provision":
          onProvision();
          break;
        case "install_update":
          installUpdate();
          break;
        case "leave_mesh":
          leaveMesh();
          break;
        case "navigate":
          navigate(action.path);
          break;
        case "open_agent":
          navigate("/");
          openAgent(action.agentId);
          break;
        case "quit":
          break;
        default: {
          const _exhaustive: never = action;
          void _exhaustive;
        }
      }
    });
  }, [target, navigate, onProvision, installUpdate, leaveMesh]);

  useEffect(() => {
    if (target !== "desktop") {
      return;
    }

    const agents = trayListState(agentsQuery);
    const agentItems =
      agents.status === "ready"
        ? {
            status: "ready" as const,
            items: agents.items
              .filter((a) => a.parent_agent_id !== null)
              .map((a) => ({
                id: a.id,
                name: a.name,
                active: a.active,
                running: a.running,
              })),
          }
        : agents;

    const browsers = trayListState(browsersQuery);
    const browserItems =
      browsers.status === "ready"
        ? {
            status: "ready" as const,
            items: browsers.items.map((b) => ({
              id: b.id,
              display: b.display,
              healthy: b.healthy,
            })),
          }
        : browsers;

    const diskLabel = statusQuery.isError
      ? "Disk · unavailable"
      : statusQuery.data
        ? formatDiskLabel(statusQuery.data.disk)
        : state === "connected"
          ? "Disk · …"
          : "Disk · —";

    const snapshot: TraySnapshot = {
      meshConnected: state === "connected",
      diskLabel,
      meshLabel:
        state === "connected"
          ? "Mesh · Online"
          : state === "connecting"
            ? "Mesh · Joining…"
            : "Mesh · Offline",
      agents: agentItems,
      browsers: browserItems,
      updateVersion: update.available ? update.version : null,
      updateInstalling: update.installing,
    };

    void syncDesktopTray(snapshot).catch((err) => {
      logLine(
        "error",
        `desktop tray update rejected: ${err instanceof Error ? err.message : String(err)}`,
        "tray_update_rejected",
      );
    });
  }, [
    target,
    state,
    statusQuery.data,
    statusQuery.isError,
    agentsQuery.data,
    agentsQuery.isError,
    agentsQuery.isSuccess,
    browsersQuery.data,
    browsersQuery.isError,
    browsersQuery.isSuccess,
    update.available,
    update.version,
    update.installing,
  ]);
}
