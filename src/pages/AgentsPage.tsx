import { useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { PageHeader } from "../chrome/PageHeader";
import { AgentTree } from "../features/agents/AgentTree";
import { EASE, SLOW_S } from "../shared/motion";

/**
 * Full-canvas agent tree: pan, zoom, pinch, node popovers.
 * Blow-up entrance remounts when arriving from home (or elsewhere).
 */
export function AgentsPage() {
  const location = useLocation();
  const entranceKey = `agents:${location.key}`;

  return (
    <motion.div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <PageHeader
        title="AGENTS"
        hint="Scroll to zoom · drag to pan · double-click to reset"
      />
      <div className="min-h-0 flex-1 px-1 pb-1">
        <AgentTree mode="full" entranceKey={entranceKey} />
      </div>
    </motion.div>
  );
}
