/** Floating lane chip above the composer — thinking / working occupancy. */

import { AnimatePresence, motion } from "motion/react";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";
import type { LaneChipLabel } from "./toolStatus";

export type { LaneChipLabel };

export type LaneChipProps = {
  label: LaneChipLabel | null;
};

/**
 * Soft glass pill that fades in above the composer while a lane is busy.
 */
export function LaneChip({ label }: LaneChipProps) {
  return (
    <AnimatePresence initial={false}>
      {label ? (
        <motion.div
          key="lane-chip"
          role="status"
          aria-label={label}
          initial={{ opacity: 0, y: 6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.96 }}
          transition={{ duration: SLOW_S, ease: EASE }}
          className="pointer-events-none mb-2 flex justify-center"
        >
          <span className="lane-chip inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium tracking-[0.04em] text-sage-text lowercase">
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={label}
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.22, ease: EASE }}
              >
                {label}
              </motion.span>
            </AnimatePresence>
          </span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
