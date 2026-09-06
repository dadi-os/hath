import { useEffect, useState } from "react";
import { detectTarget, type Target } from "../target";

/**
 * Current form factor. Platform-detected, with a DEV-only override so the
 * mobile layout can be exercised on a desktop build (`?target=mobile` or
 * ⌘⇧M).
 */
export function useTarget(): Target {
  const [override, setOverride] = useState<Target | null>(() =>
    readDevOverride(),
  );

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    const syncQuery = () => {
      setOverride(readDevOverride());
    };
    syncQuery();

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey && e.shiftKey && e.key.toLowerCase() === "m")) {
        return;
      }
      e.preventDefault();
      setOverride((prev) => {
        const next: Target =
          (prev ?? detectTarget()) === "mobile" ? "desktop" : "mobile";
        const url = new URL(window.location.href);
        url.searchParams.set("target", next);
        window.history.replaceState(null, "", url);
        return next;
      });
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("popstate", syncQuery);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("popstate", syncQuery);
    };
  }, []);

  return override ?? detectTarget();
}

function readDevOverride(): Target | null {
  if (!import.meta.env.DEV) {
    return null;
  }
  const value = new URLSearchParams(window.location.search).get("target");
  if (value === "mobile" || value === "desktop") {
    return value;
  }
  return null;
}
