import { useState } from "react";
import { useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { PageHeader } from "../chrome/PageHeader";
import { AgentGraph3D } from "../features/agents/AgentGraph3D";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";

/**
 * Full-canvas agent forest as a live 3D graph: orbit, zoom, hover details, click to chat.
 * Blow-up entrance remounts when arriving from home (or elsewhere).
 */
export function AgentsPage() {
  const location = useLocation();
  const entranceKey = `agents:${location.key}`;
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);

  return (
    <motion.div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <div className="absolute inset-0">
        <AgentGraph3D entranceKey={entranceKey} interactive toolbar={toolbar} />
      </div>
      <div className="pointer-events-none relative z-10">
        <PageHeader
          title="AGENTS"
          hint="Drag to orbit · scroll to zoom · hover for details · click to open in chat"
          trailing={<div ref={setToolbar} className="flex items-center gap-2" />}
        />
      </div>
    </motion.div>
  );
}
