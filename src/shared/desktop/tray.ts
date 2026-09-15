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
let chain: Promise<void> = Promise.resolve();
let queued: TraySnapshot | null = null;

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
 * Serializes overlapping calls on one promise chain so the latest snapshot lands.
 * macOS app menu is applied before tray icon creation.
 */
export async function syncDesktopTray(snapshot: TraySnapshot): Promise<void> {
  queued = snapshot;
  if (!isTauriRuntime()) {
    return;
  }
  chain = chain.then(drainTrayQueue, drainTrayQueue);
  await chain;
}

/** Apply the newest queued snapshot(s); re-reads {@link queued} after each apply. */
async function drainTrayQueue(): Promise<void> {
  if (!(await isDesktopTrayHost())) {
    queued = null;
    return;
  }
  while (queued) {
    const snapshot = queued;
    queued = null;
    await applyDesktopShell(snapshot);
  }
}

/**
 * Install the macOS app menu first, then the tray icon.
 * App menu must not depend on tray icon success.
 */
async function applyDesktopShell(snapshot: TraySnapshot): Promise<void> {
  const { type } = await import("@tauri-apps/plugin-os");
  const platform = type();
  const menu = await Menu.new({ items: menuBranches(snapshot) });

  if (platform === "macos") {
    await setMacAppMenu(snapshot);
  }

  try {
    await ensureTray(menu, platform);
  } catch (err) {
    if (platform === "macos") {
      throw new Error(
        `tray icon failed (app menu already set): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    throw err;
  }
}

/** Create or reuse the status-item / notification-area tray. */
async function ensureTray(menu: Menu, platform: string): Promise<void> {
  if (!tray) {
    tray = await TrayIcon.getById(TRAY_ID);
  }
  if (tray) {
    await tray.setMenu(menu);
    await tray.setVisible(true);
    return;
  }

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
    iconAsTemplate: platform === "macos",
    action: (event) => {
      if (event.type === "DoubleClick") {
        void focusMainWindow();
      }
    },
  });
}

/**
 * Install a fresh macOS app menu tree from the snapshot.
 * MenuItems cannot be parented to two menus, so this builds a separate tree.
 */
async function setMacAppMenu(snapshot: TraySnapshot): Promise<void> {
  const appMenu = await Menu.new({ items: macAppMenuBranches(snapshot) });
  await appMenu.setAsAppMenu();
}

/** macOS menu bar: Dadi / Edit / Agents / System. Edit restores Cmd+V paste. */
function macAppMenuBranches(snapshot: TraySnapshot) {
  const [dadi, agents, system] = menuBranches(snapshot);
  return [
    dadi,
    {
      id: "menu-edit",
      text: "Edit",
      items: [
        { item: "Undo" as const },
        { item: "Redo" as const },
        { item: "Separator" as const },
        { item: "Cut" as const },
        { item: "Copy" as const },
        { item: "Paste" as const },
        { item: "SelectAll" as const },
      ],
    },
    agents,
    system,
  ];
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
