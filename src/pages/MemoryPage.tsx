import { useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { PageHeader } from "../chrome/PageHeader";
import { MemoryGraph3D } from "../features/memory/MemoryGraph3D";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";

/**
 * Full Memory page: Yaad knowledge network as a live 3D force graph.
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
      <div className="absolute inset-0">
        <MemoryGraph3D entranceKey={entranceKey} />
      </div>
      <div className="pointer-events-none relative z-10">
        <PageHeader
          title="MEMORY"
          hint="Drag to orbit · scroll to zoom · click a node · expand grows the network"
        />
      </div>
    </motion.div>
  );
}
