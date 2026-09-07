import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { yaad } from "../../api";
import type { NodeRecord, PlanDetail, PlanStatus } from "../../api/types";
import { useConnection } from "../../hooks/useConnection";
import { EASE, SLOW_S } from "../../shared/motion";
import {
  addDays,
  endOfDay,
  endOfMonth,
  formatMonthTitle,
  formatTime,
  formatWeekTitle,
  isSameDay,
  isSameMonth,
  monthGridDays,
  startOfDay,
  startOfMonth,
  startOfWeek,
  toIsoBounds,
  weekDays,
  weekdayLabels,
} from "./dates";

export type TimelineView = "week" | "month";

export type TimelineCalendarProps = {
  mode: "full" | "preview";
  /** Controlled view; defaults to week. */
  view?: TimelineView;
  onViewChange?: (view: TimelineView) => void;
  className?: string;
  /** When true, omit the Someday ideas rail (preview / compact). */
  hideIdeas?: boolean;
};

type PlanNode = NodeRecord & { detail: PlanDetail | null };

function asPlan(node: NodeRecord & { detail: unknown }): PlanNode | null {
  if (node.kind !== "plan") {
    return null;
  }
  const detail = node.detail as PlanDetail | null;
  return { ...node, detail };
}

function statusOf(plan: PlanNode): PlanStatus {
  return plan.detail?.status ?? "confirmed";
}

function planStartsOn(plan: PlanNode, day: Date): boolean {
  if (!plan.occurred_at) {
    return false;
  }
  return isSameDay(new Date(plan.occurred_at), day);
}

function planOverlapsDay(plan: PlanNode, day: Date): boolean {
  if (!plan.occurred_at) {
    return false;
  }
  const start = new Date(plan.occurred_at);
  const end = plan.detail?.end_at
    ? new Date(plan.detail.end_at)
    : new Date(plan.occurred_at);
  const dayStart = startOfDay(day).getTime();
  const dayEnd = endOfDay(day).getTime();
  return start.getTime() <= dayEnd && end.getTime() >= dayStart;
}

function statusClass(status: PlanStatus): string {
  if (status === "tentative") {
    return "border border-dashed border-sage-line bg-sage-faint/80 text-sage-text";
  }
  if (status === "idea") {
    return "border border-rule bg-bone text-ink-ghost";
  }
  return "border border-transparent bg-sage-active text-ink";
}

/**
 * Week / month calendar of Yaad plans. Preview is a compact current-week ribbon.
 */
export function TimelineCalendar({
  mode,
  view: viewProp,
  onViewChange,
  className,
  hideIdeas = mode === "preview",
}: TimelineCalendarProps) {
  const { state: connection } = useConnection();
  const connected = connection === "connected";
  const preview = mode === "preview";

  const [internalView, setInternalView] = useState<TimelineView>("week");
  const view = viewProp ?? internalView;
  const setView = (next: TimelineView) => {
    onViewChange?.(next);
    if (viewProp === undefined) {
      setInternalView(next);
    }
  };

  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const today = startOfDay(new Date());

  const range = useMemo(() => {
    if (view === "week" || preview) {
      const start = startOfWeek(anchor);
      const end = endOfDay(addDays(start, 6));
      return { start, end, ...toIsoBounds(start, end) };
    }
    const start = startOfWeek(startOfMonth(anchor));
    const end = endOfDay(addDays(startOfWeek(endOfMonth(anchor)), 6));
    return { start, end, ...toIsoBounds(start, end) };
  }, [anchor, view, preview]);

  const plansQuery = useQuery({
    queryKey: [
      "yaad",
      "plans",
      range.occurred_from,
      range.occurred_to,
      preview ? "preview" : "full",
    ],
    queryFn: async () => {
      const { nodes } = await yaad.query({
        kind: "plan",
        occurred_from: range.occurred_from,
        occurred_to: range.occurred_to,
        limit: 200,
      });
      return nodes
        .map(asPlan)
        .filter((n): n is PlanNode => n !== null)
        .filter((n) => statusOf(n) !== "idea");
    },
    enabled: connected,
  });

  const ideasQuery = useQuery({
    queryKey: ["yaad", "plans", "ideas"],
    queryFn: async () => {
      const { nodes } = await yaad.query({
        status: "idea",
        limit: 50,
      });
      return nodes.map(asPlan).filter((n): n is PlanNode => n !== null);
    },
    enabled: connected && !hideIdeas,
  });

  const plans = plansQuery.data ?? [];
  const ideas = ideasQuery.data ?? [];
  const labels = weekdayLabels();

  const goPrev = () => {
    if (view === "week" || preview) {
      setAnchor((a) => addDays(a, -7));
    } else {
      setAnchor((a) => new Date(a.getFullYear(), a.getMonth() - 1, 1));
    }
  };

  const goNext = () => {
    if (view === "week" || preview) {
      setAnchor((a) => addDays(a, 7));
    } else {
      setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + 1, 1));
    }
  };

  const goToday = () => setAnchor(startOfDay(new Date()));

  if (!connected) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">Connect to load timeline</p>
      </div>
    );
  }

  if (plansQuery.isError) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-muted">Could not load plans.</p>
      </div>
    );
  }

  if (preview) {
    const days = weekDays(anchor);
    return (
      <div className={`flex h-full min-h-0 flex-col px-3 pb-3 pt-1 ${className ?? ""}`}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-ghost">{formatWeekTitle(anchor)}</span>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-7 gap-1">
          {days.map((day) => {
            const dayPlans = plans.filter((p) => planOverlapsDay(p, day));
            const isToday = isSameDay(day, today);
            return (
              <div
                key={day.toISOString()}
                className={`flex min-h-0 flex-col rounded-[6px] px-0.5 py-1 ${
                  isToday ? "bg-sage-active/50" : ""
                }`}
              >
                <span
                  className={`mb-1 text-center text-[10px] ${
                    isToday ? "font-medium text-sage-deep" : "text-ink-ghost"
                  }`}
                >
                  {day.getDate()}
                </span>
                <div className="flex flex-col gap-0.5 overflow-hidden">
                  {dayPlans.slice(0, 3).map((p) => (
                    <div
                      key={p.id}
                      className={`truncate rounded-[3px] px-1 py-0.5 text-[9px] leading-tight ${statusClass(statusOf(p))}`}
                    >
                      {p.title}
                    </div>
                  ))}
                  {dayPlans.length > 3 ? (
                    <span className="text-center text-[9px] text-ink-ghost">
                      +{dayPlans.length - 3}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex h-full min-h-0 gap-3 ${className ?? ""}`}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-[var(--radius)] border border-dashed border-sage-line bg-bone p-0.5">
            {(["week", "month"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded-[6px] px-2.5 py-1 text-[11px] font-medium tracking-wide transition-colors duration-slow ease-hath ${
                  view === v
                    ? "bg-sage-active text-sage-deep"
                    : "text-ink-ghost hover:text-ink-muted"
                }`}
              >
                {v === "week" ? "Week" : "Month"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={goPrev}
              className="rounded-[6px] px-2 py-1 text-[12px] text-sage-deep hover:bg-sage-active/40"
              aria-label="Previous"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={goToday}
              className="rounded-[6px] px-2 py-1 text-[11px] tracking-wide text-ink-muted hover:bg-sage-active/40"
            >
              Today
            </button>
            <button
              type="button"
              onClick={goNext}
              className="rounded-[6px] px-2 py-1 text-[12px] text-sage-deep hover:bg-sage-active/40"
              aria-label="Next"
            >
              ›
            </button>
          </div>
          <span className="text-[13px] text-ink">
            {view === "week" ? formatWeekTitle(anchor) : formatMonthTitle(anchor)}
          </span>
        </div>

        {plansQuery.isLoading ? (
          <p className="py-8 text-[13px] text-ink-ghost">Loading plans…</p>
        ) : view === "week" ? (
          <WeekView
            anchor={anchor}
            today={today}
            plans={plans}
            labels={labels}
          />
        ) : (
          <MonthView
            anchor={anchor}
            today={today}
            plans={plans}
            labels={labels}
            onSelectDay={(day) => {
              setAnchor(day);
              setView("week");
            }}
          />
        )}
      </div>

      {!hideIdeas ? (
        <aside className="flex w-[min(200px,28%)] shrink-0 flex-col border-l border-dashed border-sage-line pl-3">
          <span className="mb-2 text-[11px] font-medium tracking-[2px] text-sage-deep">
            SOMEDAY
          </span>
          {ideasQuery.isLoading ? (
            <p className="text-[12px] text-ink-ghost">…</p>
          ) : ideas.length === 0 ? (
            <p className="text-[12px] text-ink-ghost">No ideas yet</p>
          ) : (
            <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
              {ideas.map((idea, i) => (
                <motion.li
                  key={idea.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: SLOW_S,
                    ease: EASE,
                    delay: Math.min(i * 0.03, 0.2),
                  }}
                  className="rounded-[6px] border border-dashed border-rule px-2 py-1.5 text-[12px] leading-snug text-ink-muted"
                >
                  {idea.title}
                </motion.li>
              ))}
            </ul>
          )}
        </aside>
      ) : null}
    </div>
  );
}

function WeekView({
  anchor,
  today,
  plans,
  labels,
}: {
  anchor: Date;
  today: Date;
  plans: PlanNode[];
  labels: string[];
}) {
  const days = weekDays(anchor);
  return (
    <div className="grid min-h-0 flex-1 grid-cols-7 gap-2 overflow-hidden">
      {days.map((day, i) => {
        const dayPlans = plans
          .filter((p) => planOverlapsDay(p, day))
          .sort((a, b) =>
            (a.occurred_at ?? "").localeCompare(b.occurred_at ?? ""),
          );
        const isToday = isSameDay(day, today);
        return (
          <div
            key={day.toISOString()}
            className={`flex min-h-0 flex-col rounded-[var(--radius)] border border-dashed px-1.5 py-2 ${
              isToday
                ? "border-sage bg-sage-faint/60"
                : "border-rule bg-bone/40"
            }`}
          >
            <div className="mb-2 flex flex-col items-center gap-0.5">
              <span className="text-[10px] tracking-wide text-ink-ghost">
                {labels[i]}
              </span>
              <span
                className={`text-[13px] ${
                  isToday ? "font-medium text-sage-deep" : "text-ink"
                }`}
              >
                {day.getDate()}
              </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
              {dayPlans.length === 0 ? (
                <span className="text-center text-[11px] text-ink-ghost/70">—</span>
              ) : (
                dayPlans.map((p) => (
                  <div
                    key={p.id}
                    className={`rounded-[6px] px-1.5 py-1 text-[11px] leading-snug ${statusClass(statusOf(p))}`}
                  >
                    {planStartsOn(p, day) && p.occurred_at ? (
                      <span className="mb-0.5 block text-[10px] opacity-70">
                        {formatTime(p.occurred_at)}
                      </span>
                    ) : null}
                    <span className="line-clamp-3">{p.title}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MonthView({
  anchor,
  today,
  plans,
  labels,
  onSelectDay,
}: {
  anchor: Date;
  today: Date;
  plans: PlanNode[];
  labels: string[];
  onSelectDay: (day: Date) => void;
}) {
  const days = monthGridDays(anchor);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 grid grid-cols-7 gap-1">
        {labels.map((label) => (
          <span
            key={label}
            className="text-center text-[10px] tracking-wide text-ink-ghost"
          >
            {label}
          </span>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 gap-1">
        {days.map((day) => {
          const inMonth = isSameMonth(day, anchor);
          const isToday = isSameDay(day, today);
          const dayPlans = plans.filter((p) => planOverlapsDay(p, day));
          return (
            <button
              key={day.toISOString()}
              type="button"
              onClick={() => onSelectDay(day)}
              className={`flex min-h-[72px] flex-col rounded-[6px] border border-dashed px-1 py-1 text-left transition-colors duration-slow ease-hath hover:border-sage ${
                isToday
                  ? "border-sage bg-sage-faint/70"
                  : inMonth
                    ? "border-rule bg-bone/50"
                    : "border-transparent bg-transparent opacity-40"
              }`}
            >
              <span
                className={`mb-1 text-[11px] ${
                  isToday ? "font-medium text-sage-deep" : "text-ink-muted"
                }`}
              >
                {day.getDate()}
              </span>
              <div className="flex flex-col gap-0.5 overflow-hidden">
                {dayPlans.slice(0, 3).map((p) => (
                  <span
                    key={p.id}
                    className={`truncate rounded-[3px] px-1 py-0.5 text-[9px] leading-tight ${statusClass(statusOf(p))}`}
                  >
                    {p.title}
                  </span>
                ))}
                {dayPlans.length > 3 ? (
                  <span className="text-[9px] text-ink-ghost">
                    +{dayPlans.length - 3}
                  </span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
