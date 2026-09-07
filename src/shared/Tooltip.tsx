import {
  useId,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { EASE, SLOW_S } from "./motion";

export type TooltipProps = {
  content: string;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
};

/**
 * Lightweight hover/focus tooltip. Prefer short one-line content.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  className,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className={`relative inline-flex ${className ?? ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined}>{children}</span>
      <AnimatePresence>
        {open ? (
          <motion.span
            id={id}
            role="tooltip"
            className={`pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius)] border border-dashed border-sage-line bg-bone px-2 py-1 text-[11px] tracking-wide text-ink-muted shadow-[var(--shadow)] ${
              side === "top" ? "bottom-[calc(100%+8px)]" : "top-[calc(100%+8px)]"
            }`}
            initial={{ opacity: 0, y: side === "top" ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: side === "top" ? 4 : -4 }}
            transition={{ duration: SLOW_S, ease: EASE }}
          >
            {content}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
