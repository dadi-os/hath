import type { KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { useTarget } from "../hooks/useTarget";
import { AgentTree } from "../features/agents/AgentTree";
import { MemoryGraph } from "../features/memory/MemoryGraph";
import { SystemMap } from "../features/system/SystemMap";
import { TimelineCalendar } from "../features/timeline/TimelineCalendar";
import { EASE, SLOW_S } from "../shared/motion";
import { WidgetFrame } from "../shared/WidgetFrame";

const tile =
  "min-h-0 w-full cursor-pointer transition-[box-shadow] duration-slow ease-hath hover:shadow-[0_4px_16px_rgba(92,107,82,0.12)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage";

/**
 * Home widget grid — hardcoded 4×4 on desktop with per-widget spans.
 * Interactive bits inside (e.g. agent nodes) stop propagation for popovers.
 */
export function WidgetGridPage() {
  const navigate = useNavigate();
  const target = useTarget();
  const allowAgents = target !== "mobile";

  const open = (path: string) => () => navigate(path);
  const onActivate =
    (path: string) => (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        navigate(path);
      }
    };

  return (
    <motion.div
      className="grid h-full min-h-0 grid-cols-1 gap-5 px-2 pb-2 pt-5 auto-rows-[minmax(200px,1fr)] md:grid-cols-4 md:grid-rows-4 md:auto-rows-fr"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      {allowAgents ? (
        <WidgetFrame
          title="AGENTS"
          role="link"
          tabIndex={0}
          onClick={open("/agents")}
          onKeyDown={onActivate("/agents")}
          className={`${tile} md:col-span-2 md:row-span-2`}
        >
          <AgentTree mode="preview" entranceKey="home-agents" hideLabels />
        </WidgetFrame>
      ) : (
        <WidgetFrame
          title="AGENTS"
          className={`flex items-center justify-center px-6 md:col-span-2 md:row-span-2`}
        >
          <p className="px-4 py-8 text-center text-[13px] text-ink-ghost">
            Agent tree is available on desktop.
          </p>
        </WidgetFrame>
      )}

      <WidgetFrame
        title="MEMORY"
        role="link"
        tabIndex={0}
        onClick={open("/memory")}
        onKeyDown={onActivate("/memory")}
        className={`${tile} md:col-span-2 md:row-span-2`}
      >
        <MemoryGraph mode="preview" entranceKey="home-memory" />
      </WidgetFrame>

      <WidgetFrame
        title="TIMELINE"
        role="link"
        tabIndex={0}
        onClick={open("/timeline")}
        onKeyDown={onActivate("/timeline")}
        className={`${tile} md:col-span-2 md:row-span-2`}
      >
        <TimelineCalendar mode="preview" hideIdeas />
      </WidgetFrame>

      <WidgetFrame
        title="SYSTEM"
        role="link"
        tabIndex={0}
        onClick={open("/system")}
        onKeyDown={onActivate("/system")}
        className={`${tile} md:col-span-2 md:row-span-2`}
      >
        <SystemMap mode="preview" />
      </WidgetFrame>
    </motion.div>
  );
}
