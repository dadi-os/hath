import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";
import { BrowserFrame } from "./BrowserFrame";
import { TerminalChip } from "./TerminalChip";

export type SessionPeekProps = {
  /** Whether the hover card should render. */
  open: boolean;
  /** Viewport anchor near the tree node; null skips render. */
  anchor: { x: number; y: number } | null;
  /** Live Nas browser to preview, or null. */
  browserId: number | null;
  /** Live Nas terminal chip payload, or null. */
  terminal: { id: string; last_command: string | null } | null;
};

/**
 * Hover card for an agent-tree node that has a live Nas browser and/or terminal.
 * View-only — pointer-events none so the tree stays draggable.
 */
export function SessionPeek({ open, anchor, browserId, terminal }: SessionPeekProps) {
  if (!anchor) {
    return null;
  }

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="pointer-events-none fixed z-[55] flex flex-col items-start gap-1.5"
          style={{
            left:
              anchor.x + 186 > window.innerWidth - 12
                ? Math.max(12, anchor.x - 186)
                : anchor.x + 16,
            top: Math.max(12, anchor.y - 8),
          }}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 2 }}
          transition={{ duration: SLOW_S, ease: EASE }}
        >
          {terminal ? (
            <TerminalChip command={terminal.last_command} terminalId={terminal.id} />
          ) : null}
          {browserId !== null ? (
            <BrowserFrame browserId={browserId} variant="peek" />
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
