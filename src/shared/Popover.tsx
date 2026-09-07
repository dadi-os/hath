import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { EASE, SLOW_S } from "./motion";

export type PopoverAnchor = { x: number; y: number };

export type PopoverProps = {
  open: boolean;
  onClose: () => void;
  /**
   * Position relative to `containerRef` when provided, otherwise treated as
   * viewport coordinates.
   */
  anchor: PopoverAnchor;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  widthPx?: number;
  "aria-label"?: string;
  /** Element that owns the coordinate space for `anchor`. */
  containerRef?: RefObject<HTMLElement | null>;
};

/**
 * Anchored floating panel portaled to document.body (avoids overflow clipping).
 * Escape and outside click dismiss.
 */
export function Popover({
  open,
  onClose,
  anchor,
  children,
  className,
  style,
  widthPx = 340,
  "aria-label": ariaLabel,
  containerRef,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const container = containerRef?.current;
    const rect = container?.getBoundingClientRect();
    const rawLeft = (rect?.left ?? 0) + anchor.x + 16;
    const rawTop = (rect?.top ?? 0) + anchor.y + 12;
    const maxLeft = window.innerWidth - widthPx - 12;
    const maxTop = window.innerHeight - 120;
    setPos({
      left: Math.max(12, Math.min(rawLeft, maxLeft)),
      top: Math.max(12, Math.min(rawTop, maxTop)),
    });
  }, [open, anchor.x, anchor.y, containerRef, widthPx]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      const el = panelRef.current;
      if (el && !el.contains(e.target as Node)) {
        onClose();
      }
    };
    // Defer so the opening click does not immediately close.
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-label={ariaLabel}
          className={`widget-surface fixed z-50 flex flex-col overflow-hidden ${className ?? ""}`}
          style={{
            left: pos.left,
            top: pos.top,
            width: `min(${widthPx}px, calc(100vw - 24px))`,
            ...style,
          }}
          initial={{ opacity: 0, scale: 0.94, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 4 }}
          transition={{ duration: SLOW_S, ease: EASE }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
