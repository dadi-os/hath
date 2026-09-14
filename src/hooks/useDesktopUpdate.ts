import { useCallback, useEffect, useState } from "react";
import { isTauriRuntime } from "../shared/api/runtime";

/** Desktop platforms that support Tauri's updater plugin. */
const DESKTOP_OS = new Set(["linux", "windows", "macos"]);

export type DesktopUpdateState = {
  /** True when a newer signed release is available. */
  available: boolean;
  /** Remote SemVer from latest.json when available. */
  version: string | null;
  /** True while downloadAndInstall is in flight. */
  installing: boolean;
  /** Last error from check or install, if any. */
  error: string | null;
  /** Download, install, and relaunch. No-op when nothing is available. */
  install: () => Promise<void>;
};

type PendingUpdate = {
  version: string;
  downloadAndInstall: () => Promise<void>;
};

/**
 * Check GitHub Releases for a newer desktop build. No-op on browser / iOS.
 * Does not auto-install — call {@link DesktopUpdateState.install} explicitly.
 */
export function useDesktopUpdate(): DesktopUpdateState {
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      if (!isTauriRuntime()) {
        return;
      }
      const { type } = await import("@tauri-apps/plugin-os");
      const platform = type();
      if (!DESKTOP_OS.has(platform)) {
        return;
      }
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (cancelled || !update) {
          return;
        }
        setPending({
          version: update.version,
          downloadAndInstall: () => update.downloadAndInstall(),
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

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

  return {
    available: pending != null,
    version: pending?.version ?? null,
    installing,
    error,
    install,
  };
}
