import { motion } from "motion/react";
import { PageHeader } from "../chrome/PageHeader";
import { TimelineCalendar } from "../features/timeline/TimelineCalendar";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";

/**
 * Full Timeline page: week / month plan calendar with a Someday ideas rail.
 */
export function TimelinePage() {
  return (
    <motion.div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <PageHeader
        title="TIMELINE"
        hint="Plans by week and month · ideas live in Someday"
      />
      <div className="min-h-0 flex-1 px-1 pb-1">
        <TimelineCalendar mode="full" />
      </div>
    </motion.div>
  );
}
