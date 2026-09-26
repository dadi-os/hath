import type { KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { useTarget } from "../hooks/useTarget";
import { AgentGraph3D } from "../features/agents/AgentGraph3D";
import { ChaaviCounts } from "../features/chaavi/ChaaviCounts";
import { GharHouse } from "../features/ghar/house";
import { MemoryCounters } from "../features/memory/MemoryCounters";
import { SystemMap } from "../features/system/SystemMap";
import { TimelineCalendar } from "../features/timeline/TimelineCalendar";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";
import { WidgetFrame } from "../shared/components/WidgetFrame";

const tile =
  "min-h-0 w-full cursor-pointer transition-[box-shadow,transform] duration-slow ease-hath hover:shadow-[var(--shadow-deep)] hover:-translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage";

/**
 * Home widget grid — 4×4 on desktop.
 * Agents 2×2, Timeline 2×2, Memory 2×1, Ghar 2×1, Chaavi 1×1, System 1×2.
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
      className="grid h-full min-h-0 grid-cols-1 gap-5 overflow-hidden px-2 py-2 auto-rows-[minmax(160px,1fr)] md:grid-cols-4 md:grid-rows-4 md:auto-rows-fr"
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
          className={`${tile} md:col-span-2 md:row-span-2 md:col-start-1 md:row-start-1`}
        >
          <AgentGraph3D entranceKey="home-agents" interactive={false} />
        </WidgetFrame>
      ) : (
        <WidgetFrame
          title="AGENTS"
          className="flex items-center justify-center px-6 md:col-span-2 md:row-span-2 md:col-start-1 md:row-start-1"
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
        className={`${tile} md:col-span-2 md:col-start-1 md:row-start-3`}
      >
        <MemoryCounters />
      </WidgetFrame>

      <WidgetFrame
        title="TIMELINE"
        role="link"
        tabIndex={0}
        onClick={open("/timeline")}
        onKeyDown={onActivate("/timeline")}
        className={`${tile} md:col-span-2 md:col-start-3 md:row-span-2 md:row-start-1`}
      >
        <TimelineCalendar mode="preview" hideIdeas />
      </WidgetFrame>

      <WidgetFrame
        title="GHAR"
        role="link"
        tabIndex={0}
        onClick={open("/ghar")}
        onKeyDown={onActivate("/ghar")}
        className={`${tile} md:col-span-2 md:col-start-1 md:row-start-4`}
      >
        <GharHouse mode="preview" />
      </WidgetFrame>

      <WidgetFrame
        title="CHAAVI"
        role="link"
        tabIndex={0}
        onClick={open("/chaavi")}
        onKeyDown={onActivate("/chaavi")}
        className={`${tile} md:col-span-1 md:col-start-3 md:row-start-3`}
      >
        <ChaaviCounts />
      </WidgetFrame>

      <WidgetFrame
        title="SYSTEM"
        role="link"
        tabIndex={0}
        onClick={open("/system")}
        onKeyDown={onActivate("/system")}
        className={`${tile} md:col-span-1 md:col-start-4 md:row-span-2 md:row-start-3`}
      >
        <SystemMap mode="preview" />
      </WidgetFrame>
    </motion.div>
  );
}
