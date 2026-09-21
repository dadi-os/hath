import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { PageHeader } from "../chrome/PageHeader";
import { CommissionSheet } from "../features/ghar/commission";
import { GharHouse } from "../features/ghar/house";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";

/** Full Ghar page — rooms as glass panels, commissioning in a drawer beside them. */
export function GharPage() {
  const [commissioning, setCommissioning] = useState(false);

  return (
    <motion.div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <PageHeader
        title="GHAR"
        hint="Press a device · drag it into a room"
        trailing={
          <motion.button
            type="button"
            onClick={() => setCommissioning(true)}
            whileTap={{ scale: 0.96 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="rounded-[7px] border border-dashed border-sage-line bg-[var(--glass-sheet)] px-3 py-1.5 text-[11px] font-medium tracking-[0.14em] text-sage-deep uppercase shadow-[var(--shadow)] backdrop-blur-sm transition-[color,border-color,background-color] duration-slow ease-hath hover:border-sage hover:bg-sage-active/50"
          >
            Commission
          </motion.button>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <GharHouse mode="full" />
        </div>
        <AnimatePresence>
          {commissioning ? (
            <motion.div
              key="commission"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 320, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: SLOW_S, ease: EASE }}
              className="h-full shrink-0 overflow-hidden"
            >
              <CommissionSheet onClose={() => setCommissioning(false)} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
