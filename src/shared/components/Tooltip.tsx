import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { EASE, SLOW_S } from "../lib/ux/motion";

export type TooltipProps = {
  content: string;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
};

const PAD = 10;

/**
 * Portaled tooltip — floats above chrome, flips when near viewport edges.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  className,
}: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0, placed: side });

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      return;
    }
    const trigger = triggerRef.current.getBoundingClientRect();
    const tip = tipRef.current?.getBoundingClientRect();
    const tipW = tip?.width ?? 120;
    const tipH = tip?.height ?? 28;

    let placed = side;
    let top =
      placed === "top" ? trigger.top - tipH - 8 : trigger.bottom + 8;
    if (placed === "top" && top < PAD) {
      placed = "bottom";
      top = trigger.bottom + 8;
    } else if (placed === "bottom" && top + tipH > window.innerHeight - PAD) {
      placed = "top";
      top = trigger.top - tipH - 8;
    }

    let left = trigger.left + trigger.width / 2 - tipW / 2;
    left = Math.max(PAD, Math.min(left, window.innerWidth - tipW - PAD));
    top = Math.max(PAD, Math.min(top, window.innerHeight - tipH - PAD));
    setPos({ left, top, placed });
  }, [open, side, content]);

  return (
    <span
      ref={triggerRef}
      className={`inline-flex ${className ?? ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined}>{children}</span>
      {createPortal(
        <AnimatePresence>
          {open ? (
            <motion.span
              ref={tipRef}
              id={id}
              role="tooltip"
              className="pointer-events-none fixed z-[60] whitespace-nowrap rounded-[var(--radius)] border border-dashed border-sage-line bg-bone px-2 py-1 text-[11px] tracking-wide text-ink-muted shadow-[var(--shadow)]"
              style={{ left: pos.left, top: pos.top }}
              initial={{ opacity: 0, y: pos.placed === "top" ? 4 : -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: SLOW_S, ease: EASE }}
            >
              {content}
            </motion.span>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </span>
  );
}
