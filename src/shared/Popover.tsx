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
  /** Small arrow pointing toward the anchor. */
  caret?: boolean;
};

const PAD = 12;
const GAP = 14;
const CARET = 7;

type Placement = {
  left: number;
  top: number;
  caretSide: "left" | "right";
  caretOffset: number;
};

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
  caret = false,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placement>({
    left: 0,
    top: 0,
    caretSide: "left",
    caretOffset: 24,
  });

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

      let caretSide: Placement["caretSide"] = "left";
      let left = originX + GAP;
      let top = originY - 20;

      // Prefer opening to the right; flip when near the edge.
      if (left + w > window.innerWidth - PAD) {
        left = originX - w - GAP;
        caretSide = "right";
      }
      if (left < PAD) {
        left = PAD;
      }
      if (top + h > window.innerHeight - PAD) {
        top = originY - h + 20;
      }
      if (top < PAD) {
        top = PAD;
      }

      left = Math.max(PAD, Math.min(left, window.innerWidth - w - PAD));
      top = Math.max(
        PAD,
        Math.min(
          top,
          window.innerHeight - Math.min(h, window.innerHeight - PAD * 2) - PAD,
        ),
      );

      const caretOffset = Math.max(16, Math.min(originY - top, h - 16));
      setPos({ left, top, caretSide, caretOffset });
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

  const caretStyle = ((): CSSProperties | undefined => {
    if (!caret) {
      return undefined;
    }
    const base: CSSProperties = {
      position: "absolute",
      width: CARET * 2,
      height: CARET * 2,
      background: "var(--bone)",
      border: "1px dashed var(--sage-line)",
      transform: "rotate(45deg)",
      pointerEvents: "none",
      zIndex: 1,
    };
    if (pos.caretSide === "left") {
      return {
        ...base,
        left: -CARET,
        top: pos.caretOffset - CARET,
        borderRight: "none",
        borderTop: "none",
      };
    }
    return {
      ...base,
      right: -CARET,
      top: pos.caretOffset - CARET,
      borderLeft: "none",
      borderBottom: "none",
    };
  })();

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-label={ariaLabel}
          className={`fixed z-[60] flex max-h-[min(70vh,520px)] flex-col overflow-visible border border-dashed border-sage-line bg-bone shadow-[var(--shadow)] ${className ?? ""}`}
          style={{
            left: pos.left,
            top: pos.top,
            width: `min(${widthPx}px, calc(100vw - 24px))`,
            borderRadius: "var(--radius)",
            ...style,
          }}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 2 }}
          transition={{ duration: SLOW_S, ease: EASE }}
        >
          {caret ? <span aria-hidden style={caretStyle} /> : null}
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
            {children}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
