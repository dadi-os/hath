import { useMemo, useSyncExternalStore } from "react";

const DARK = "(prefers-color-scheme: dark)";

/** Subscribe to OS light/dark flips, which swap the `:root` token values. */
function subscribeScheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Current OS color scheme. */
function schemeSnapshot(): "dark" | "light" {
  return window.matchMedia(DARK).matches ? "dark" : "light";
}

/**
 * Resolved values of CSS custom properties on `:root` (e.g. `--sage-deep`), re-read
 * whenever the OS color scheme flips. For WebGL scenes, which cannot use `var()`.
 * `names` is compared by value, so an inline array literal is fine.
 * @throws When a token is not defined, so a renamed token fails loudly.
 */
export function useThemeTokens<K extends string>(names: readonly K[]): Record<K, string> {
  const scheme = useSyncExternalStore(subscribeScheme, schemeSnapshot);
  const key = names.join(",");
  return useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const out = {} as Record<K, string>;
    for (const name of names) {
      const value = style.getPropertyValue(name).trim();
      if (!value) {
        throw new Error(`theme token ${name} is not defined`);
      }
      out[name] = value;
    }
    return out;
  }, [key, scheme]);
}
