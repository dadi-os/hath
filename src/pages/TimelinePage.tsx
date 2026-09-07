import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { TimelineCalendar } from "../features/timeline/TimelineCalendar";
import { IconBack, IconButton } from "../shared/IconButton";
import { EASE, SLOW_S } from "../shared/motion";
import { Tooltip } from "../shared/Tooltip";

/**
 * Full Timeline page: week / month plan calendar with a Someday ideas rail.
 */
export function TimelinePage() {
  const navigate = useNavigate();

  return (
    <motion.div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <div className="mb-3 flex shrink-0 items-start gap-3 px-1">
        <Tooltip content="Back home">
          <span className="inline-flex">
            <IconButton
              label="Back home"
              size="sm"
              onClick={() => navigate("/")}
            >
              <IconBack />
            </IconButton>
          </span>
        </Tooltip>
        <div>
          <span className="text-[11px] font-medium tracking-[2.5px] text-sage-deep">
            TIMELINE
          </span>
          <p className="mt-1 text-[11px] text-ink-ghost">
            Plans by week and month · ideas live in Someday
          </p>
        </div>
      </div>
      <div className="min-h-0 flex-1 px-1 pb-1">
        <TimelineCalendar mode="full" />
      </div>
    </motion.div>
  );
}
