/**
 * Unified desktop tray (macOS menu-bar status item, Windows tray, Linux panel).
 * Rebuilds a Dadi / Agents / System menu from a live snapshot.
 */

import { defaultWindowIcon } from "@tauri-apps/api/app";
import { Menu } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { dispatchDesktopShell } from "../../store/desktopShell";
import { isTauriRuntime } from "../api/runtime";

const TRAY_ID = "dadi-tray";

export type TrayAgent = {
  id: string;
  name: string;
  active: boolean;
  running: { reasoning: boolean; conversation: boolean };
};

export type TrayBrowser = {
  id: number;
  display: string;
  healthy: boolean;
};

/** Live list, still loading, or last fetch failed. */
export type TrayListState<T> =
  | { status: "ready"; items: T[] }
  | { status: "pending" }
  | { status: "error" };

export type TraySnapshot = {
  meshConnected: boolean;
  /** Preformatted disk row for the System menu. */
  diskLabel: string;
  meshLabel: string;
  agents: TrayListState<TrayAgent>;
  browsers: TrayListState<TrayBrowser>;
  updateVersion: string | null;
  updateInstalling: boolean;
};

let tray: TrayIcon | null = null;
let building = false;

/** True on desktop Tauri (not iOS/Android webview shells). */
export async function isDesktopTrayHost(): Promise<boolean> {
  if (!isTauriRuntime()) {
    return false;
  }
  const { type } = await import("@tauri-apps/plugin-os");
  const platform = type();
  return platform === "macos" || platform === "windows" || platform === "linux";
}

/**
 * Create or refresh the tray icon menu from {@link TraySnapshot}.
 * Safe to call often — rebuilds the menu in place. Rejects on tray API failure.
 */
export async function syncDesktopTray(snapshot: TraySnapshot): Promise<void> {
  if (!(await isDesktopTrayHost()) || building) {
    return;
  }
  building = true;
  try {
    const menu = await Menu.new({ items: menuBranches(snapshot) });
    if (!tray) {
      const icon = await defaultWindowIcon();
      if (!icon) {
        throw new Error("default window icon is missing for tray");
      }
      tray = await TrayIcon.new({
        id: TRAY_ID,
        icon,
        tooltip: "Dadi",
        menu,
        showMenuOnLeftClick: true,
        action: (event) => {
          if (event.type === "DoubleClick") {
            void focusMainWindow();
          }
        },
      });
    } else {
      await tray.setMenu(menu);
    }

    const { type } = await import("@tauri-apps/plugin-os");
    if (type() === "macos") {
      await setMacAppMenu(snapshot);
    }
  } finally {
    building = false;
  }
}

/**
 * Install a fresh macOS app menu tree from the snapshot.
 * MenuItems cannot be parented to two menus, so this builds a separate tree.
 */
async function setMacAppMenu(snapshot: TraySnapshot): Promise<void> {
  const appMenu = await Menu.new({ items: menuBranches(snapshot) });
  await appMenu.setAsAppMenu();
}

/** Top-level Dadi / Agents / System submenu roots. */
function menuBranches(snapshot: TraySnapshot) {
  return [
    {
      id: "menu-dadi",
      text: "Dadi",
      items: dadiItems(snapshot),
    },
    {
      id: "menu-agents",
      text: "Agents",
      items: agentItems(snapshot),
    },
    {
      id: "menu-system",
      text: "System",
      items: systemItems(snapshot),
    },
  ];
}

/** Dadi submenu: show, provision, update, leave mesh, quit. */
function dadiItems(snapshot: TraySnapshot) {
  return [
    {
      id: "dadi-show",
      text: "Show Dadi",
      action: () => {
        void focusMainWindow();
        dispatchDesktopShell({ type: "show_window" });
      },
    },
    {
      id: "dadi-provision",
      text: "Provision client…",
      enabled: snapshot.meshConnected,
      action: () => {
        void focusMainWindow();
        dispatchDesktopShell({ type: "provision" });
      },
    },
    {
      id: "dadi-update",
      text: snapshot.updateInstalling
        ? "Installing update…"
        : snapshot.updateVersion
          ? `Install update ${snapshot.updateVersion}`
          : "Install update",
      enabled: Boolean(snapshot.updateVersion) && !snapshot.updateInstalling,
      action: () => {
        dispatchDesktopShell({ type: "install_update" });
      },
    },
    { item: "Separator" as const },
    {
      id: "dadi-mesh",
      text: snapshot.meshConnected ? "Leave mesh" : "Mesh offline",
      enabled: snapshot.meshConnected,
      action: () => {
        dispatchDesktopShell({ type: "leave_mesh" });
      },
    },
    {
      id: "dadi-quit",
      text: "Quit",
      action: () => {
        void import("@tauri-apps/plugin-process").then(({ exit }) => exit(0));
      },
    },
  ];
}

/** Agents submenu: open agents page, per-agent chats, headed browsers. */
function agentItems(snapshot: TraySnapshot) {
  const items: Array<Record<string, unknown>> = [
    {
      id: "agents-page",
      text: "Open Agents…",
      action: () => {
        void focusMainWindow();
        dispatchDesktopShell({ type: "navigate", path: "/agents" });
      },
    },
  ];

  if (snapshot.agents.status === "error") {
    items.push({
      id: "agents-error",
      text: "Agents unavailable",
      enabled: false,
    });
  } else if (snapshot.agents.status === "pending") {
    items.push({
      id: "agents-pending",
      text: snapshot.meshConnected ? "Loading agents…" : "Connect to list agents",
      enabled: false,
    });
  } else if (snapshot.agents.items.length > 0) {
    items.push({ item: "Separator" });
    for (const agent of snapshot.agents.items) {
      const statusBits: string[] = [];
      if (agent.running.reasoning) {
        statusBits.push("reasoning");
      }
      if (agent.running.conversation) {
        statusBits.push("conversation");
      }
      const status =
        statusBits.length > 0
          ? statusBits.join(" · ")
          : agent.active
            ? "idle"
            : "paused";

      items.push({
        id: `agent-${agent.id}`,
        text: agent.name,
        items: [
          {
            id: `agent-open-${agent.id}`,
            text: "Open chat",
            action: () => {
              void focusMainWindow();
              dispatchDesktopShell({ type: "open_agent", agentId: agent.id });
            },
          },
          {
            id: `agent-status-${agent.id}`,
            text: status,
            enabled: false,
          },
        ],
      });
    }
  } else {
    items.push({
      id: "agents-empty",
      text: snapshot.meshConnected ? "No agents yet" : "Connect to list agents",
      enabled: false,
    });
  }

  items.push({ item: "Separator" });
  if (snapshot.browsers.status === "error") {
    items.push({
      id: "browsers-error",
      text: "Browsers unavailable",
      enabled: false,
    });
  } else if (snapshot.browsers.status === "pending") {
    items.push({
      id: "browsers-pending",
      text: snapshot.meshConnected ? "Loading browsers…" : "Browsers unavailable",
      enabled: false,
    });
  } else if (snapshot.browsers.items.length > 0) {
    items.push({
      id: "browsers",
      text: "Browsers",
      items: snapshot.browsers.items.map((browser) => ({
        id: `browser-${browser.id}`,
        text: `Browser ${browser.id} · ${browser.display}${
          browser.healthy ? "" : " · unhealthy"
        }`,
        enabled: false,
      })),
    });
  } else {
    items.push({
      id: "browsers-empty",
      text: snapshot.meshConnected ? "No browsers" : "Browsers unavailable",
      enabled: false,
    });
  }

  return items;
}

/** System submenu: disk/mesh status and deep links. */
function systemItems(snapshot: TraySnapshot) {
  return [
    {
      id: "system-disk",
      text: snapshot.diskLabel,
      enabled: false,
    },
    {
      id: "system-mesh",
      text: snapshot.meshLabel,
      enabled: false,
    },
    { item: "Separator" as const },
    {
      id: "system-open",
      text: "Open System…",
      action: () => {
        void focusMainWindow();
        dispatchDesktopShell({ type: "navigate", path: "/system" });
      },
    },
    {
      id: "system-memory",
      text: "Open Memory…",
      action: () => {
        void focusMainWindow();
        dispatchDesktopShell({ type: "navigate", path: "/memory" });
      },
    },
    {
      id: "system-timeline",
      text: "Open Timeline…",
      action: () => {
        void focusMainWindow();
        dispatchDesktopShell({ type: "navigate", path: "/timeline" });
      },
    },
  ];
}

/** Bring the main Hath window forward. */
async function focusMainWindow(): Promise<void> {
  const window = getCurrentWindow();
  await window.unminimize();
  await window.show();
  await window.setFocus();
}

/** Format Nas disk sample for a tray label. */
export function formatDiskLabel(disk: {
  free_bytes: number;
  total_bytes: number;
}): string {
  if (disk.total_bytes <= 0) {
    return "Disk · —";
  }
  const used = disk.total_bytes - disk.free_bytes;
  const pct = Math.round((used / disk.total_bytes) * 100);
  const freeGiB = disk.free_bytes / (1024 * 1024 * 1024);
  return `Disk · ${pct}% used · ${freeGiB.toFixed(1)} GiB free`;
}
