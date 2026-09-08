import { useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { PageHeader } from "../chrome/PageHeader";
import { MemoryGraph } from "../features/memory/MemoryGraph";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";

/**
 * Full Memory page: Yaad knowledge graph.
 */
export function MemoryPage() {
  const location = useLocation();
  const entranceKey = `memory:${location.key}`;

  return (
    <motion.div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <PageHeader
        title="MEMORY"
        hint="Scroll to zoom · drag to pan · click a node to expand"
      />
      <div className="min-h-0 flex-1 px-1 pb-1">
        <MemoryGraph mode="full" entranceKey={entranceKey} />
      </div>
    </motion.div>
  );
}
