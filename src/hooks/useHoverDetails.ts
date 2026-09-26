import { useCallback, useEffect, useRef, useState } from "react";

/** Point relative to the details container, where the popover anchors. */
export type DetailsAnchor = { x: number; y: number };

/** Open delay after the pointer lands on an item, so passing over it does not flash. */
const OPEN_DELAY_MS = 160;
/** Close delay after the pointer leaves, so it can travel onto the popover. */
const CLOSE_DELAY_MS = 320;

/** Hover-to-preview, click-to-pin state for one details popover. */
export type HoverDetails = {
  /** Item whose details are open, or null. */
  id: string | null;
  anchor: DetailsAnchor | null;
  /** True when opened by `pin`; leaving no longer closes it. */
  pinned: boolean;
  /** Pointer entered an item: open after a short delay (or move the anchor if already open). */
  hover: (id: string, at: DetailsAnchor) => void;
  /** Pointer left an item or the popover: close after a short delay unless pinned. */
  leave: () => void;
  /** Pointer reached the popover: cancel a pending close. */
  keep: () => void;
  /** Open immediately and stay open until `close`. */
  pin: (id: string, at: DetailsAnchor) => void;
  close: () => void;
};

/**
 * Timing for a details popover shared by hover preview and click pinning.
 * Resets whenever `resetKey` changes (e.g. on page re-entry).
 */
export function useHoverDetails(resetKey: string): HoverDetails {
  const [state, setState] = useState<{
    id: string | null;
    anchor: DetailsAnchor | null;
    pinned: boolean;
  }>({ id: null, anchor: null, pinned: false });
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const pinnedRef = useRef(false);
  const idRef = useRef<string | null>(null);
  pinnedRef.current = state.pinned;
  idRef.current = state.id;

  const clearTimers = useCallback(() => {
    for (const timer of [openTimer, closeTimer]) {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    }
  }, []);

  const close = useCallback(() => {
    clearTimers();
    setState({ id: null, anchor: null, pinned: false });
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);
  useEffect(() => close(), [resetKey, close]);

  const hover = useCallback(
    (id: string, at: DetailsAnchor) => {
      if (pinnedRef.current) {
        return;
      }
      clearTimers();
      if (idRef.current === id) {
        return;
      }
      openTimer.current = window.setTimeout(() => {
        setState({ id, anchor: at, pinned: false });
      }, OPEN_DELAY_MS);
    },
    [clearTimers],
  );

  const leave = useCallback(() => {
    if (pinnedRef.current) {
      return;
    }
    clearTimers();
    closeTimer.current = window.setTimeout(() => {
      setState({ id: null, anchor: null, pinned: false });
    }, CLOSE_DELAY_MS);
  }, [clearTimers]);

  const keep = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const pin = useCallback(
    (id: string, at: DetailsAnchor) => {
      clearTimers();
      setState({ id, anchor: at, pinned: true });
    },
    [clearTimers],
  );

  return { ...state, hover, leave, keep, pin, close };
}
