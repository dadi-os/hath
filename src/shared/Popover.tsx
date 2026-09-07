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

const PAD = 12;

/**
 * Anchored floating panel portaled to document.body.
 * Flips / clamps to stay in the viewport — never clipped by widgets.
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
    const place = () => {
      const container = containerRef?.current;
      const rect = container?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      const w = Math.min(widthPx, window.innerWidth - PAD * 2);
      const h = panel?.height ?? 280;

      const originX = (rect?.left ?? 0) + anchor.x;
      const originY = (rect?.top ?? 0) + anchor.y;

      let left = originX + 16;
      let top = originY + 12;

      // Prefer opening to the right/below; flip when near edges.
      if (left + w > window.innerWidth - PAD) {
        left = originX - w - 12;
      }
      if (left < PAD) {
        left = PAD;
      }
      if (top + h > window.innerHeight - PAD) {
        top = originY - h - 12;
      }
      if (top < PAD) {
        top = PAD;
      }
      // Final clamp after flips.
      left = Math.max(PAD, Math.min(left, window.innerWidth - w - PAD));
      top = Math.max(PAD, Math.min(top, window.innerHeight - Math.min(h, window.innerHeight - PAD * 2) - PAD));

      setPos({ left, top });
    };

    place();
    // Re-measure after paint once content height is known.
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
    };
  }, [open, anchor.x, anchor.y, containerRef, widthPx, children]);

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
          className={`widget-surface fixed z-[60] flex max-h-[min(70vh,520px)] flex-col overflow-hidden ${className ?? ""}`}
          style={{
            left: pos.left,
            top: pos.top,
            width: `min(${widthPx}px, calc(100vw - 24px))`,
            ...style,
          }}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 2 }}
          transition={{ duration: SLOW_S, ease: EASE }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
