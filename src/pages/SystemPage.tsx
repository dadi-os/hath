import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { LogExplorer } from "../features/logs/LogExplorer";
import { SystemMap } from "../features/system/SystemMap";
import { IconBack, IconButton } from "../shared/IconButton";
import { EASE, SLOW_S } from "../shared/motion";
import { Tooltip } from "../shared/Tooltip";

/**
 * Split system view: health + recent errors on one side, full log explorer
 * on the other (~half page). Uptime stays in the header.
 */
export function SystemPage() {
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
            SYSTEM
          </span>
          <p className="mt-1 text-[11px] text-ink-ghost">
            Reachability · disk · logs
          </p>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 px-1 pb-1 lg:grid-cols-2 lg:gap-5">
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius)] border border-dashed border-sage-line bg-bone/40 px-3 py-3">
          <span className="mb-3 shrink-0 text-[11px] font-medium tracking-[2px] text-sage-deep">
            BOX
          </span>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <SystemMap mode="full" />
          </div>
        </section>

        <section className="flex min-h-[min(420px,48vh)] min-w-0 flex-col overflow-hidden rounded-[var(--radius)] border border-dashed border-sage-line bg-bone/40 px-3 py-3 lg:min-h-0">
          <span className="mb-3 shrink-0 text-[11px] font-medium tracking-[2px] text-sage-deep">
            LOGS
          </span>
          <div className="min-h-0 min-w-0 flex-1">
            <LogExplorer />
          </div>
        </section>
      </div>
    </motion.div>
  );
}
