import { motion } from "motion/react";
import { PageHeader } from "../chrome/PageHeader";
import { GharHouse } from "../features/ghar/house";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";

/** Full Ghar page. Pairing lives in Unplaced. */
export function GharPage() {
  return (
    <motion.div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <PageHeader
        title="GHAR"
        hint="Click a room or a device to switch it · hover a device for color and name"
      />
      <div className="min-h-0 flex-1">
        <GharHouse mode="full" />
      </div>
    </motion.div>
  );
}
