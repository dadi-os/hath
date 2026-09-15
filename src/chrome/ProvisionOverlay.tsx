import { AnimatePresence, motion } from "motion/react";
import { ProvisionDevice } from "../features/system/ProvisionDevice";
import { IconButton, IconDismiss } from "../shared/components/IconButton";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";

export interface ProvisionOverlayProps {
  /** Whether the modal is visible. */
  open: boolean;
  /** Dismiss the modal (backdrop, close button). */
  onClose: () => void;
}

/**
 * Desktop-only provision modal — opened from the tray / app menu, not a page button.
 */
export function ProvisionOverlay({ open, onClose }: ProvisionOverlayProps) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="frost-scrim absolute inset-0 z-50 flex items-center justify-center px-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: SLOW_S, ease: EASE }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Provision client"
            className="relative flex max-h-[min(90vh,40rem)] w-full max-w-sm flex-col overflow-hidden rounded-[var(--radius-window)] border border-[var(--glass-border)] bg-[var(--glass-sheet)] p-5 shadow-[var(--shadow-deep)]"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: SLOW_S, ease: EASE }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium tracking-[2px] text-ink-ghost">
                PROVISION CLIENT
              </span>
              <IconButton label="Close" size="sm" onClick={onClose}>
                <IconDismiss />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ProvisionDevice />
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
