import { useNavigate, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { AgentTree } from "../features/agents/AgentTree";
import { IconBack, IconButton } from "../shared/IconButton";
import { EASE, SLOW_S } from "../shared/motion";
import { Tooltip } from "../shared/Tooltip";

/**
 * Full-canvas agent tree: pan, zoom, pinch, node popovers.
 * Blow-up entrance remounts when arriving from home (or elsewhere).
 */
export function AgentsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const entranceKey = `agents:${location.key}`;

  return (
    <motion.div
      className="relative h-full min-h-0 w-full overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <div className="pointer-events-none absolute left-4 top-3 z-10 flex items-start gap-3">
        <Tooltip content="Back home">
          <span className="pointer-events-auto inline-flex">
            <IconButton label="Back home" onClick={() => navigate("/")}>
              <IconBack />
            </IconButton>
          </span>
        </Tooltip>
        <div>
          <span className="text-[11px] font-medium tracking-[2.5px] text-sage-deep">
            AGENTS
          </span>
          <p className="mt-1 text-[11px] text-ink-ghost">
            Scroll to zoom · drag to pan · double-click to reset
          </p>
        </div>
      </div>
      <AgentTree mode="full" entranceKey={entranceKey} />
    </motion.div>
  );
}
