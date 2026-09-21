/**
 * Desktop tray + macOS app menu.
 *
 * The menu tree is installed once. Live labels are written on the MenuItem
 * objects created here — not looked up later with Menu.get, which does not
 * find nested items and left "Mesh offline" / "…" stuck on screen.
 *
 * After install, only setText / setEnabled. setAsAppMenu and tray.setMenu
 * dismiss an open macOS menu. Agent rows are appended only when the count
 * grows, and only real agents (no empty placeholder slots).
 */

import { defaultWindowIcon } from "@tauri-apps/api/app";
import {
  Menu,
  MenuItem,
  Submenu,
} from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { dispatchDesktopShell } from "../../store/desktopShell";
import { isTauriRuntime } from "../api/runtime";

const TRAY_ID = "dadi-tray";

/** Cap agent rows in the menu (full list is on the Agents page). */
const AGENT_SLOTS_MAX = 16;

/** One agent row in the Agents menu. */
export type TrayAgent = {
  id: string;
  name: string;
  active: boolean;
  running: { reasoning: boolean; conversation: boolean };
};

/** Live list, still loading, or last fetch failed. */
export type TrayListState<T> =
  | { status: "ready"; items: T[] }
  | { status: "pending" }
  | { status: "error" };

/** Live bits patched into the static menu tree. */
export type TraySnapshot = {
  meshConnected: boolean;
  updateInstalling: boolean;
  agents: TrayListState<TrayAgent>;
};

/** Items we mutate after install. Held so updates do not depend on Menu.get. */
type LiveItems = {
  provision: MenuItem;
  mesh: MenuItem;
  update: MenuItem;
  agentsStatus: MenuItem;
  agentsMenu: Submenu;
  agentRows: MenuItem[];
};

let tray: TrayIcon | null = null;
let appMenu: Menu | null = null;
let trayMenu: Menu | null = null;
let appLive: LiveItems | null = null;
let trayLive: LiveItems | null = null;
let installed = false;
let trayMenuBound = false;
let chain: Promise<void> = Promise.resolve();
let queued: TraySnapshot | null = null;
let lastLiveKey: string | null = null;

/** Slot index → agent id for click handlers (shared by app + tray menus). */
const slotAgentIds: Array<string | null> = Array.from(
  { length: AGENT_SLOTS_MAX },
  () => null,
);

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
 * Apply tray / app-menu live state from {@link TraySnapshot}.
 * Installs the static tree once; later calls only mutate held items.
 */
export async function syncDesktopTray(snapshot: TraySnapshot): Promise<void> {
  queued = snapshot;
  if (!isTauriRuntime()) {
    return;
  }
  chain = chain.then(drainTrayQueue, drainTrayQueue);
  await chain;
}

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

async function applyDesktopShell(snapshot: TraySnapshot): Promise<void> {
  const { type } = await import("@tauri-apps/plugin-os");
  const platform = type();

  if (!installed) {
    if (platform === "macos") {
      const built = await buildMenu(snapshot, true);
      appMenu = built.menu;
      appLive = built.live;
      await appMenu.setAsAppMenu();
    }
    const trayBuilt = await buildMenu(snapshot, false);
    trayMenu = trayBuilt.menu;
    trayLive = trayBuilt.live;
    await ensureTray(trayMenu, platform);
    installed = true;
    lastLiveKey = liveFingerprint(snapshot);
    return;
  }

  const liveKey = liveFingerprint(snapshot);
  if (liveKey === lastLiveKey) {
    return;
  }
  lastLiveKey = liveKey;

  if (appLive) {
    await patchLive(appLive, snapshot);
  }
  if (trayLive) {
    await patchLive(trayLive, snapshot);
  }
}

/** Create or reuse the status-item / notification-area tray. */
async function ensureTray(menu: Menu, platform: string): Promise<void> {
  if (!tray) {
    tray = await TrayIcon.getById(TRAY_ID);
  }
  if (tray) {
    if (!trayMenuBound) {
      await tray.setMenu(menu);
      trayMenuBound = true;
    }
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
  trayMenuBound = true;
}

/** Write mesh / update / agent labels onto the items created at install. */
async function patchLive(live: LiveItems, snapshot: TraySnapshot): Promise<void> {
  await setEnabledIf(live.provision, snapshot.meshConnected);
  await setTextIf(
    live.mesh,
    snapshot.meshConnected ? "Leave mesh" : "Mesh offline",
  );
  await setEnabledIf(live.mesh, snapshot.meshConnected);
  await setTextIf(
    live.update,
    snapshot.updateInstalling ? "Checking for updates…" : "Check for Updates…",
  );
  await setEnabledIf(live.update, !snapshot.updateInstalling);
  await setTextIf(live.agentsStatus, agentsStatusText(snapshot));
  await syncAgentRows(live, snapshot);
}

/**
 * Grow or shrink agent rows to match the roster. Labels update in place.
 * No blank placeholder rows.
 */
async function syncAgentRows(
  live: LiveItems,
  snapshot: TraySnapshot,
): Promise<void> {
  const desired =
    snapshot.agents.status === "ready"
      ? snapshot.agents.items.slice(0, AGENT_SLOTS_MAX)
      : [];

  while (live.agentRows.length < desired.length) {
    const index = live.agentRows.length;
    const row = await MenuItem.new(agentSlotOptions(index, desired[index]!));
    slotAgentIds[index] = desired[index]!.id;
    await live.agentsMenu.append(row);
    live.agentRows.push(row);
  }
  while (live.agentRows.length > desired.length) {
    const row = live.agentRows.pop();
    if (row) {
      slotAgentIds[live.agentRows.length] = null;
      await live.agentsMenu.remove(row);
    }
  }
  for (let i = 0; i < desired.length; i++) {
    const agent = desired[i]!;
    slotAgentIds[i] = agent.id;
    const row = live.agentRows[i];
    if (row) {
      await setTextIf(row, agentSlotLabel(agent));
      await setEnabledIf(row, true);
    }
  }
}

async function setTextIf(item: MenuItem, text: string): Promise<void> {
  if ((await item.text()) !== text) {
    await item.setText(text);
  }
}

async function setEnabledIf(item: MenuItem, enabled: boolean): Promise<void> {
  if ((await item.isEnabled()) !== enabled) {
    await item.setEnabled(enabled);
  }
}

function agentSlotLabel(agent: TrayAgent): string {
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
  return `${agent.name}  ·  ${status}`;
}

function agentsStatusText(snapshot: TraySnapshot): string {
  if (snapshot.agents.status === "error") {
    return "Agents unavailable";
  }
  if (snapshot.agents.status === "pending") {
    return snapshot.meshConnected
      ? "Loading agents…"
      : "Connect to list agents";
  }
  const n = snapshot.agents.items.length;
  if (n === 0) {
    return snapshot.meshConnected ? "No agents yet" : "Connect to list agents";
  }
  if (n > AGENT_SLOTS_MAX) {
    return `${AGENT_SLOTS_MAX} of ${n} — Open Agents… for all`;
  }
  return `${n} agent${n === 1 ? "" : "s"}`;
}

/** Fingerprint of fields that drive in-place patches (skip no-op syncs). */
function liveFingerprint(snapshot: TraySnapshot): string {
  return JSON.stringify({
    meshConnected: snapshot.meshConnected,
    updateInstalling: snapshot.updateInstalling,
    agents: snapshot.agents,
  });
}

/**
 * Build one menu tree and keep the items that change.
 * `withEdit` is the macOS app menu (adds Edit). Tray omits it.
 */
async function buildMenu(
  snapshot: TraySnapshot,
  withEdit: boolean,
): Promise<{ menu: Menu; live: LiveItems }> {
  const live = await createLiveItems(snapshot);
  const branches = [
    live.dadi,
    ...(withEdit ? [editSubmenu()] : []),
    live.agentsMenu,
    viewSubmenu(),
  ];
  const menu = await Menu.new({ items: branches });
  return { menu, live: live.items };
}

async function createLiveItems(snapshot: TraySnapshot): Promise<{
  dadi: Submenu;
  agentsMenu: Submenu;
  items: LiveItems;
}> {
  const provision = await MenuItem.new({
    id: "dadi-provision",
    text: "Provision client…",
    enabled: snapshot.meshConnected,
    action: () => {
      void focusMainWindow();
      dispatchDesktopShell({ type: "provision" });
    },
  });
  const mesh = await MenuItem.new({
    id: "dadi-mesh",
    text: snapshot.meshConnected ? "Leave mesh" : "Mesh offline",
    enabled: snapshot.meshConnected,
    action: () => {
      dispatchDesktopShell({ type: "leave_mesh" });
    },
  });
  const update = await MenuItem.new({
    id: "dadi-update",
    text: snapshot.updateInstalling
      ? "Checking for updates…"
      : "Check for Updates…",
    enabled: !snapshot.updateInstalling,
    action: () => {
      dispatchDesktopShell({ type: "check_update" });
    },
  });
  const show = await MenuItem.new({
    id: "dadi-show",
    text: "Show Dadi",
    action: () => {
      void focusMainWindow();
      dispatchDesktopShell({ type: "show_window" });
    },
  });
  const quit = await MenuItem.new({
    id: "dadi-quit",
    text: "Quit",
    accelerator: "CmdOrCtrl+Q",
    action: () => {
      void import("@tauri-apps/plugin-process").then(({ exit }) => exit(0));
    },
  });
  const dadi = await Submenu.new({
    id: "menu-dadi",
    text: "Dadi",
    items: [show, provision, update, { item: "Separator" }, mesh, quit],
  });

  const openAgents = await MenuItem.new({
    id: "agents-page",
    text: "Open Agents…",
    action: () => {
      void focusMainWindow();
      dispatchDesktopShell({ type: "navigate", path: "/agents" });
    },
  });
  const agentsStatus = await MenuItem.new({
    id: "agents-status",
    text: agentsStatusText(snapshot),
    enabled: false,
  });

  const desired =
    snapshot.agents.status === "ready"
      ? snapshot.agents.items.slice(0, AGENT_SLOTS_MAX)
      : [];
  const agentRows: MenuItem[] = [];
  for (let i = 0; i < desired.length; i++) {
    const row = await MenuItem.new(agentSlotOptions(i, desired[i]!));
    slotAgentIds[i] = desired[i]!.id;
    agentRows.push(row);
  }

  const agentsMenu = await Submenu.new({
    id: "menu-agents",
    text: "Agents",
    items: [openAgents, { item: "Separator" }, agentsStatus, ...agentRows],
  });

  return {
    dadi,
    agentsMenu,
    items: { provision, mesh, update, agentsStatus, agentsMenu, agentRows },
  };
}

function agentSlotOptions(index: number, agent: TrayAgent) {
  return {
    id: `agent-slot-${index}`,
    text: agentSlotLabel(agent),
    enabled: true,
    action: () => {
      const agentId = slotAgentIds[index];
      if (!agentId) {
        return;
      }
      void focusMainWindow();
      dispatchDesktopShell({ type: "open_agent", agentId });
    },
  };
}

function editSubmenu() {
  return {
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
  };
}

function viewSubmenu() {
  return {
    id: "menu-view",
    text: "View",
    items: [
      navItem("view-agents", "Agents…", "/agents"),
      navItem("view-system", "System…", "/system"),
      navItem("view-memory", "Memory…", "/memory"),
      navItem("view-timeline", "Timeline…", "/timeline"),
      navItem("view-chaavi", "Chaavi…", "/chaavi"),
      navItem("view-ghar", "Ghar…", "/ghar"),
    ],
  };
}

function navItem(id: string, text: string, path: string) {
  return {
    id,
    text,
    action: () => {
      void focusMainWindow();
      dispatchDesktopShell({ type: "navigate", path });
    },
  };
}

/** Bring the main Hath window forward. */
async function focusMainWindow(): Promise<void> {
  const window = getCurrentWindow();
  await window.unminimize();
  await window.show();
  await window.setFocus();
}
