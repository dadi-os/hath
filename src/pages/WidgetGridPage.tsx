import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { useTarget } from "../hooks/useTarget";
import { AgentTree } from "../features/agents/AgentTree";
import { EASE, SLOW_S } from "../shared/motion";
import { Tooltip } from "../shared/Tooltip";

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
      className="grid h-full min-h-0 grid-cols-1 gap-4 p-1 md:grid-cols-2 xl:grid-cols-3"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      {allowAgents ? (
        <div
          role="link"
          tabIndex={0}
          onClick={openAgents}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openAgents();
            }
          }}
          className="widget-surface group relative flex h-[min(320px,42vh)] min-h-[220px] w-full cursor-pointer flex-col overflow-hidden text-left transition-[border-color,box-shadow] duration-slow ease-hath hover:border-sage hover:shadow-[0_4px_16px_rgba(92,107,82,0.1)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
        >
          <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4 py-3">
            <span className="text-[11px] font-medium tracking-[2.5px] text-sage-deep">
              AGENTS
            </span>
            <Tooltip content="Open full tree">
              <span className="text-[11px] tracking-wide text-ink-ghost opacity-0 transition-opacity duration-slow ease-hath group-hover:opacity-100">
                Open →
              </span>
            </Tooltip>
          </div>
          <div className="min-h-0 flex-1 pt-8">
            <AgentTree mode="preview" entranceKey="home-agents" />
          </div>
        </div>
      ) : (
        <div className="widget-surface flex h-[min(240px,36vh)] items-center justify-center px-6">
          <p className="text-[13px] text-ink-ghost">
            Agent tree is available on desktop.
          </p>
        </div>
      )}
    </motion.div>
  );
}
