import { useCallback, useState } from "react";
import { isTauriRuntime } from "../shared/api/runtime";
import { logLine } from "../shared/lib/platform/log";

/** Desktop platforms that support Tauri's updater plugin. */
const DESKTOP_OS = new Set(["linux", "windows", "macos"]);

export type DesktopUpdateState = {
  /** True when a newer signed release is available. */
  available: boolean;
  /** Remote SemVer from latest.json when available. */
  version: string | null;
  /** True while check or downloadAndInstall is in flight. */
  installing: boolean;
  /** Last error from check or install, if any. */
  error: string | null;
  /**
   * Menu-driven check: probe for an update and install+relaunch when one
   * exists. No-op on browser / iOS / unsupported hosts.
   */
  check: () => Promise<void>;
  /** Download, install, and relaunch. No-op when nothing is available. */
  install: () => Promise<void>;
};

type PendingUpdate = {
  version: string;
  downloadAndInstall: () => Promise<void>;
};

async function isDesktopUpdaterHost(): Promise<boolean> {
  if (!isTauriRuntime()) {
    return false;
  }
  const { type } = await import("@tauri-apps/plugin-os");
  return DESKTOP_OS.has(type());
}

/**
 * Desktop updater for the tray / app menu "Check for Updates…" action.
 * Does not auto-check on mount — updates are user-initiated.
 */
export function useDesktopUpdate(): DesktopUpdateState {
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = useCallback(async () => {
    if (!pending || installing) {
      return;
    }
    setInstalling(true);
    setError(null);
    try {
      await pending.downloadAndInstall();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInstalling(false);
    }
  }, [pending, installing]);

  const check = useCallback(async () => {
    if (installing) {
      return;
    }
    if (!(await isDesktopUpdaterHost())) {
      return;
    }
    setInstalling(true);
    setError(null);
    try {
      const { check: checkUpdate } = await import("@tauri-apps/plugin-updater");
      const update = await checkUpdate();
      if (!update) {
        logLine("info", "no desktop update available", "desktop_update_none");
        setPending(null);
        setInstalling(false);
        return;
      }
      const next: PendingUpdate = {
        version: update.version,
        downloadAndInstall: () => update.downloadAndInstall(),
      };
      setPending(next);
      logLine(
        "info",
        `desktop update ${update.version} found; installing`,
        "desktop_update_install",
      );
      await next.downloadAndInstall();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setInstalling(false);
      logLine("error", message, "desktop_update_failed");
    }
  }, [installing]);

  return {
    available: pending != null,
    version: pending?.version ?? null,
    installing,
    error,
    check,
    install,
  };
}
