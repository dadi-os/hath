import type { KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { useTarget } from "../hooks/useTarget";
import { AgentTree } from "../features/agents/AgentTree";
import { ChaaviCounts } from "../features/chaavi/ChaaviCounts";
import { GharRoster } from "../features/ghar/GharRoster";
import { MemoryCounters } from "../features/memory/MemoryCounters";
import { SystemMap } from "../features/system/SystemMap";
import { TimelineCalendar } from "../features/timeline/TimelineCalendar";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";
import { WidgetFrame } from "../shared/components/WidgetFrame";

const tile =
  "min-h-0 w-full cursor-pointer transition-[box-shadow,transform] duration-slow ease-hath hover:shadow-[var(--shadow-deep)] hover:-translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage";

/**
 * Home widget grid — 4×4 on desktop.
 * Agents 2×1, Memory 2×1, Timeline 2×2, Ghar 1×1, Chaavi 1×1, System 1×2.
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
      className="grid h-full min-h-0 grid-cols-1 gap-5 overflow-hidden px-2 pb-2 pt-5 auto-rows-[minmax(160px,1fr)] md:grid-cols-4 md:grid-rows-4 md:auto-rows-fr"
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
          className={`${tile} md:col-span-2 md:row-span-1`}
        >
          <AgentTree mode="preview" entranceKey="home-agents" />
        </WidgetFrame>
      ) : (
        <WidgetFrame
          title="AGENTS"
          className="flex items-center justify-center px-6 md:col-span-2 md:row-span-1"
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
        className={`${tile} md:col-span-2 md:row-span-1`}
      >
        <MemoryCounters />
      </WidgetFrame>

      <WidgetFrame
        title="TIMELINE"
        role="link"
        tabIndex={0}
        onClick={open("/timeline")}
        onKeyDown={onActivate("/timeline")}
        className={`${tile} md:col-span-2 md:col-start-1 md:row-span-2 md:row-start-2`}
      >
        <TimelineCalendar mode="preview" hideIdeas />
      </WidgetFrame>

      <WidgetFrame
        title="GHAR"
        role="link"
        tabIndex={0}
        onClick={open("/ghar")}
        onKeyDown={onActivate("/ghar")}
        className={`${tile} md:col-span-1 md:col-start-3 md:row-start-2`}
      >
        <GharRoster mode="preview" />
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
        className={`${tile} md:col-span-1 md:col-start-4 md:row-span-2 md:row-start-2`}
      >
        <SystemMap mode="preview" />
      </WidgetFrame>
    </motion.div>
  );
}
