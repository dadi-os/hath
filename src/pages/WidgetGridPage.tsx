import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { useTarget } from "../hooks/useTarget";
import { AgentTree } from "../features/agents/AgentTree";
import { EASE, SLOW_S } from "../shared/motion";
import { WidgetFrame } from "../shared/WidgetFrame";

/**
 * Home widget grid. Widgets are clickable surfaces that open their page;
 * interactive bits inside (e.g. agent nodes) stop propagation for popovers.
 */
export function WidgetGridPage() {
  const navigate = useNavigate();
  const target = useTarget();
  const allowAgents = target !== "mobile";

  const openAgents = () => {
    navigate("/agents");
  };

  return (
    <motion.div
      className="grid h-full min-h-0 grid-cols-1 gap-5 p-2 md:grid-cols-2 xl:grid-cols-3"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      {allowAgents ? (
        <WidgetFrame
          title="AGENTS"
          role="link"
          tabIndex={0}
          onClick={openAgents}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openAgents();
            }
          }}
          className="h-[min(280px,38vh)] min-h-[200px] w-full cursor-pointer transition-[box-shadow] duration-slow ease-hath hover:shadow-[0_4px_16px_rgba(92,107,82,0.12)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
        >
          <AgentTree mode="preview" entranceKey="home-agents" hideLabels />
        </WidgetFrame>
      ) : (
        <WidgetFrame
          title="AGENTS"
          className="flex h-[min(200px,32vh)] items-center justify-center px-6"
        >
          <p className="px-4 py-8 text-center text-[13px] text-ink-ghost">
            Agent tree is available on desktop.
          </p>
        </WidgetFrame>
      )}
    </motion.div>
  );
}
