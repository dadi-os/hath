import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { hierarchy, tree, type HierarchyPointLink, type HierarchyPointNode } from "d3-hierarchy";
import { motion } from "motion/react";
import { dimaag } from "../api";
import type { AgentRecord, LogRecord } from "../api/types";
import { useConnection } from "../hooks/useConnection";
import { AGENTS_QUERY_KEY } from "../hooks/useEvents";
import { getRunning, seedRunningFromAgents, subscribeRunning } from "../store/running";

const NODE_SPACING_X = 140;
const NODE_SPACING_Y = 110;
const VIEW_PAD = 56;
const R_ACTIVE = 10;
const R_DORMANT = 6;
const EASE = [0.22, 0.61, 0.36, 1] as const;
const SLOW_S = 1.2;

type AgentTreeNode = {
  id: string;
  name: string;
  active: boolean;
  children?: AgentTreeNode[];
};

type NodeVisual = "running" | "idle" | "dormant";

type ViewTransform = { x: number; y: number; k: number };

/**
 * Build a hierarchy from parent_agent_id. Root is the sole null-parent agent.
 * Orphans (null or dangling parent) attach to root rather than disappearing.
 */
function buildTree(agents: AgentRecord[]): AgentTreeNode {
  if (agents.length === 0) {
    throw new Error("GET /agents returned no agents");
  }

  const byId = new Map(agents.map((a) => [a.id, a]));
  const rootAgent = agents.find((a) => a.parent_agent_id === null);
  if (!rootAgent) {
    throw new Error("GET /agents has no root agent");
  }

  const childrenOf = new Map<string, AgentRecord[]>();
  for (const agent of agents) {
    if (agent.id === rootAgent.id) {
      continue;
    }
    let parentId = agent.parent_agent_id;
    if (parentId === null || !byId.has(parentId)) {
      parentId = rootAgent.id;
    }
    const list = childrenOf.get(parentId) ?? [];
    list.push(agent);
    childrenOf.set(parentId, list);
  }

  function toNode(agent: AgentRecord): AgentTreeNode {
    const kids = childrenOf.get(agent.id) ?? [];
    return {
      id: agent.id,
      name: agent.name,
      active: agent.active,
      children: kids.length > 0 ? kids.map(toNode) : undefined,
    };
  }

  return toNode(rootAgent);
}

function linkPath(link: HierarchyPointLink<AgentTreeNode>): string {
  const { source, target } = link;
  const midY = (source.y + target.y) / 2;
  return `M${source.x},${source.y} C${source.x},${midY} ${target.x},${midY} ${target.x},${target.y}`;
}

function visualState(
  agent: AgentRecord,
  running: { reasoning: boolean; conversation: boolean } | undefined,
): NodeVisual {
  if (!agent.active) {
    return "dormant";
  }
  const lanes = running ?? agent.running;
  if (lanes.reasoning || lanes.conversation) {
    return "running";
  }
  return "idle";
}

function runningLaneLabel(running: {
  reasoning: boolean;
  conversation: boolean;
}): string | null {
  if (running.reasoning && running.conversation) {
    return "reasoning + conversation";
  }
  if (running.reasoning) {
    return "reasoning";
  }
  if (running.conversation) {
    return "conversation";
  }
  return null;
}

function formatThought(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string" && b.text.trim()) {
        parts.push(b.text.trim());
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        parts.push(`[${b.name}]`);
      }
    }
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }
  return "thought";
}

function summarizeInput(input: unknown): string {
  if (input == null) {
    return "";
  }
  if (typeof input === "string") {
    return input.length > 96 ? `${input.slice(0, 96)}…` : input;
  }
  try {
    const s = JSON.stringify(input);
    return s.length > 96 ? `${s.slice(0, 96)}…` : s;
  } catch {
    return "";
  }
}

function formatLogLine(log: LogRecord): { text: string; error?: boolean } {
  if (log.event === "thought") {
    return { text: formatThought(log.payload) };
  }
  if (log.event === "tool_call") {
    const name =
      typeof log.payload.name === "string" ? log.payload.name : "tool";
    const input = summarizeInput(log.payload.input);
    return { text: input ? `${name} · ${input}` : name };
  }
  if (log.event === "tool_result") {
    const err = log.payload.is_error === true;
    const content =
      typeof log.payload.content === "string"
        ? log.payload.content
        : summarizeInput(log.payload.content);
    return {
      text: content ? `result · ${content}` : "result",
      error: err,
    };
  }
  const content =
    typeof log.payload.content === "string" ? log.payload.content : "message";
  return { text: content };
}

function clientToSvg(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) {
    return { x: 0, y: 0 };
  }
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

/**
 * Live agent tree. All agents stay visible including dormant; pruning is manual.
 * Links redraw instantly when layout shifts — node positions animate with motion.
 */
export function AgentsPage() {
  const { state: connection } = useConnection();
  const connected = connection === "connected";
  const runningMap = useSyncExternalStore(subscribeRunning, getRunning, getRunning);

  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: async () => {
      const { agents } = await dimaag.listAgents();
      seedRunningFromAgents(agents);
      return agents;
    },
    enabled: connected,
  });

  const agents = agentsQuery.data;
  const agentsById = useMemo(() => {
    const map = new Map<string, AgentRecord>();
    if (agents) {
      for (const a of agents) {
        map.set(a.id, a);
      }
    }
    return map;
  }, [agents]);

  const layout = useMemo(() => {
    if (!agents || agents.length === 0) {
      return null;
    }
    const root = hierarchy(buildTree(agents));
    const positioned = tree<AgentTreeNode>().nodeSize([
      NODE_SPACING_X,
      NODE_SPACING_Y,
    ])(root);
    const nodes = positioned.descendants();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }
    return {
      nodes,
      links: positioned.links(),
      viewBox: {
        x: minX - VIEW_PAD,
        y: minY - VIEW_PAD,
        w: Math.max(maxX - minX + VIEW_PAD * 2, VIEW_PAD * 2),
        h: Math.max(maxY - minY + VIEW_PAD * 2 + 28, VIEW_PAD * 2),
      },
    };
  }, [agents]);

  const knownIdsRef = useRef<Set<string>>(new Set());
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (!agents) {
      return;
    }
    if (!bootstrappedRef.current) {
      knownIdsRef.current = new Set(agents.map((a) => a.id));
      bootstrappedRef.current = true;
      return;
    }
    for (const a of agents) {
      knownIdsRef.current.add(a.id);
    }
  }, [agents]);

  const [view, setView] = useState<ViewTransform>({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{
    active: boolean;
    moved: boolean;
    lastX: number;
    lastY: number;
    pointerId: number | null;
  }>({ active: false, moved: false, lastX: 0, lastY: 0, pointerId: null });
  const pinchRef = useRef<{
    dist: number;
    midX: number;
    midY: number;
  } | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const resetView = () => setView({ x: 0, y: 0, k: 1 });

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) {
      return;
    }
    dragRef.current = {
      active: true,
      moved: false,
      lastX: e.clientX,
      lastY: e.clientY,
      pointerId: e.pointerId,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag.active) {
      return;
    }
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    if (!drag.moved && Math.hypot(dx, dy) < 3) {
      return;
    }
    drag.moved = true;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    const svg = svgRef.current;
    const layoutBox = layout?.viewBox;
    if (!svg || !layoutBox) {
      return;
    }
    const rect = svg.getBoundingClientRect();
    const scaleX = layoutBox.w / rect.width;
    const scaleY = layoutBox.h / rect.height;
    setView((v) => ({
      ...v,
      x: v.x + dx * scaleX,
      y: v.y + dy * scaleY,
    }));
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (drag.pointerId === e.pointerId) {
      drag.active = false;
      drag.pointerId = null;
    }
  };

  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) {
      return;
    }
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    const pt = clientToSvg(svg, e.clientX, e.clientY);
    setView((v) => {
      const k = Math.min(4, Math.max(0.25, v.k * factor));
      return {
        k,
        x: pt.x - ((pt.x - v.x) / v.k) * k,
        y: pt.y - ((pt.y - v.y) / v.k) * k,
      };
    });
  };

  const onTouchStart = (e: React.TouchEvent<SVGSVGElement>) => {
    if (e.touches.length !== 2) {
      pinchRef.current = null;
      return;
    }
    const a = e.touches[0];
    const b = e.touches[1];
    pinchRef.current = {
      dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
      midX: (a.clientX + b.clientX) / 2,
      midY: (a.clientY + b.clientY) / 2,
    };
  };

  const onTouchMove = (e: React.TouchEvent<SVGSVGElement>) => {
    if (e.touches.length !== 2 || !pinchRef.current || !svgRef.current) {
      return;
    }
    e.preventDefault();
    const a = e.touches[0];
    const b = e.touches[1];
    const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    const factor = dist / pinchRef.current.dist;
    pinchRef.current = {
      dist,
      midX: (a.clientX + b.clientX) / 2,
      midY: (a.clientY + b.clientY) / 2,
    };
    const pt = clientToSvg(
      svgRef.current,
      pinchRef.current.midX,
      pinchRef.current.midY,
    );
    setView((v) => {
      const k = Math.min(4, Math.max(0.25, v.k * factor));
      return {
        k,
        x: pt.x - ((pt.x - v.x) / v.k) * k,
        y: pt.y - ((pt.y - v.y) / v.k) * k,
      };
    });
  };

  const onTouchEnd = () => {
    pinchRef.current = null;
  };

  const openNode = (
    node: HierarchyPointNode<AgentTreeNode>,
    clientX: number,
    clientY: number,
  ) => {
    setSelectedId(node.data.id);
    const page = pageRef.current;
    if (!page) {
      setAnchor({ x: clientX, y: clientY });
      return;
    }
    const rect = page.getBoundingClientRect();
    setAnchor({ x: clientX - rect.left, y: clientY - rect.top });
  };

  const movePopoverToAgent = (agentId: string) => {
    setSelectedId(agentId);
    const node = layout?.nodes.find((n) => n.data.id === agentId);
    const svg = svgRef.current;
    const page = pageRef.current;
    if (!node || !svg || !page) {
      return;
    }
    const pt = svg.createSVGPoint();
    pt.x = node.x * view.k + view.x;
    pt.y = node.y * view.k + view.y;
    const ctm = svg.getScreenCTM();
    if (!ctm) {
      return;
    }
    const screen = pt.matrixTransform(ctm);
    const rect = page.getBoundingClientRect();
    setAnchor({ x: screen.x - rect.left, y: screen.y - rect.top });
  };

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedId(null);
        setAnchor(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  if (agentsQuery.isError) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[15px] text-ink-muted">
          Could not load agents.
        </p>
      </div>
    );
  }

  if (!layout || !agents) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[15px] text-ink-muted">Loading agents…</p>
      </div>
    );
  }

  const { viewBox } = layout;

  return (
    <div ref={pageRef} className="relative h-full min-h-0 w-full">
      <svg
        ref={svgRef}
        className="h-full w-full touch-none"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={resetView}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {layout.links.map((link) => (
            <path
              key={`${link.source.data.id}-${link.target.data.id}`}
              d={linkPath(link)}
              fill="none"
              stroke="var(--sage-line)"
              strokeWidth={0.7}
              strokeOpacity={0.9}
            />
          ))}

          {layout.nodes.map((node) => {
            const agent = agentsById.get(node.data.id);
            if (!agent) {
              return null;
            }
            const visual = visualState(agent, runningMap[agent.id]);
            const isRoot = agent.parent_agent_id === null;
            const r = visual === "dormant" ? R_DORMANT : R_ACTIVE;
            const fill =
              visual === "dormant" ? "var(--sage-line)" : "var(--sage)";
            const fillOpacity = visual === "dormant" ? 0.55 : 1;
            const isSpawn =
              bootstrappedRef.current && !knownIdsRef.current.has(agent.id);
            const parent = node.parent;
            const initial =
              isSpawn && parent
                ? { x: parent.x, y: parent.y, opacity: 0, scale: 0.45 }
                : { x: node.x, y: node.y, opacity: 1, scale: 1 };

            return (
              <motion.g
                key={agent.id}
                initial={initial}
                animate={{ x: node.x, y: node.y, opacity: 1, scale: 1 }}
                transition={{ duration: SLOW_S, ease: EASE }}
                style={{ cursor: "pointer" }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (dragRef.current.moved) {
                    return;
                  }
                  openNode(node, e.clientX, e.clientY);
                }}
              >
                {visual === "running" && (
                  <circle
                    r={r + 7}
                    fill="none"
                    stroke="var(--sage)"
                    strokeWidth={1.25}
                    className="animate-breath"
                  />
                )}
                <circle
                  r={r}
                  fill={fill}
                  fillOpacity={fillOpacity}
                  stroke={selectedId === agent.id ? "var(--sage-deep)" : "none"}
                  strokeWidth={selectedId === agent.id ? 1.5 : 0}
                />
                <text
                  y={r + 14}
                  textAnchor="middle"
                  fill="var(--ink-muted)"
                  fontSize={isRoot ? 12 : 10}
                  style={{ userSelect: "none" }}
                >
                  {agent.name}
                </text>
              </motion.g>
            );
          })}
        </g>
      </svg>

      {selectedId && anchor && (
        <AgentPopover
          agentId={selectedId}
          agentsById={agentsById}
          runningMap={runningMap}
          anchor={anchor}
          onClose={() => {
            setSelectedId(null);
            setAnchor(null);
          }}
          onSelectParent={movePopoverToAgent}
        />
      )}
    </div>
  );
}

type AgentPopoverProps = {
  agentId: string;
  agentsById: Map<string, AgentRecord>;
  runningMap: ReturnType<typeof getRunning>;
  anchor: { x: number; y: number };
  onClose: () => void;
  onSelectParent: (id: string) => void;
};

function AgentPopover({
  agentId,
  agentsById,
  runningMap,
  anchor,
  onClose,
  onSelectParent,
}: AgentPopoverProps) {
  const { state: connection } = useConnection();
  const connected = connection === "connected";
  const [promptOpen, setPromptOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const detailQuery = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => dimaag.getAgent(agentId),
    enabled: connected,
  });

  const logsQuery = useQuery({
    queryKey: ["agent-logs", agentId, "recent"],
    queryFn: async () => {
      const { logs } = await dimaag.getAgentLogs(agentId, { limit: 20 });
      return logs;
    },
    enabled: connected,
  });

  useEffect(() => {
    setPromptOpen(false);
  }, [agentId]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = panelRef.current;
      if (el && !el.contains(e.target as Node)) {
        onClose();
      }
    };
    // Defer so the opening click does not immediately close.
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const listAgent = agentsById.get(agentId);
  const detail = detailQuery.data;
  const running =
    runningMap[agentId] ??
    detail?.running ??
    listAgent?.running ?? { reasoning: false, conversation: false };
  const active = detail?.active ?? listAgent?.active ?? false;
  const name = detail?.name ?? listAgent?.name ?? "…";
  const lane = runningLaneLabel(running);
  const parentId = detail?.parent_agent_id ?? listAgent?.parent_agent_id ?? null;
  const parent = parentId ? agentsById.get(parentId) : undefined;
  const childCount = detail?.children.length ?? 0;

  const parentEl = panelRef.current?.parentElement;
  const maxLeft = (parentEl?.clientWidth ?? 720) - 352;
  const maxTop = (parentEl?.clientHeight ?? 480) - 120;
  const left = Math.max(12, Math.min(anchor.x + 16, maxLeft));
  const top = Math.max(12, Math.min(anchor.y + 12, maxTop));

  return (
    <div
      ref={panelRef}
      className="widget-surface absolute z-20 flex max-h-[min(70%,520px)] w-[min(340px,calc(100%-24px))] flex-col overflow-hidden"
      style={{ left, top }}
      role="dialog"
      aria-label={`${name} details`}
    >
      <div className="shrink-0 border-b border-rule/60 px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-medium text-ink">{name}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] tracking-wide text-ink-faint hover:text-ink-muted"
          >
            ESC
          </button>
        </div>
        <p className="mt-1 text-[12px] text-ink-muted">
          {lane ? (
            <>
              Running · <span className="text-sage-deep">{lane}</span>
            </>
          ) : active ? (
            "Idle"
          ) : (
            "Dormant"
          )}
          {" · "}
          {active ? "active" : "dormant"}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {detailQuery.isError && (
          <p className="text-[13px] text-ink-muted">Could not load agent detail.</p>
        )}

        {detail && (
          <>
            <section className="mb-4">
              <h3 className="mb-1.5 text-[11px] font-medium tracking-[2px] text-ink-faint">
                SYSTEM PROMPT
              </h3>
              <p
                className={`whitespace-pre-wrap text-[13px] leading-relaxed text-ink ${
                  promptOpen ? "" : "line-clamp-4"
                }`}
              >
                {detail.system_prompt}
              </p>
              {detail.system_prompt.length > 160 && (
                <button
                  type="button"
                  className="mt-1 text-[12px] text-sage-deep"
                  onClick={() => setPromptOpen((v) => !v)}
                >
                  {promptOpen ? "Collapse" : "Expand"}
                </button>
              )}
            </section>

            <section className="mb-4">
              <h3 className="mb-1.5 text-[11px] font-medium tracking-[2px] text-ink-faint">
                TOOLS
              </h3>
              {detail.tools.length === 0 ? (
                <p className="text-[13px] text-ink-muted">No granted tools.</p>
              ) : (
                <ul className="space-y-2">
                  {detail.tools.map((t) => (
                    <li key={t.name}>
                      <div className="text-[13px] font-medium text-ink">{t.name}</div>
                      <div className="text-[12px] leading-snug text-ink-muted">
                        {t.usage}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mb-4">
              <h3 className="mb-1.5 text-[11px] font-medium tracking-[2px] text-ink-faint">
                RELATIONS
              </h3>
              <p className="text-[13px] text-ink-muted">
                Parent:{" "}
                {parent ? (
                  <button
                    type="button"
                    className="text-sage-deep"
                    onClick={() => onSelectParent(parent.id)}
                  >
                    {parent.name}
                  </button>
                ) : (
                  "—"
                )}
              </p>
              <p className="mt-0.5 text-[13px] text-ink-muted">
                Children: {childCount}
              </p>
            </section>

            {/* Browser session screens land here when browser tools exist. */}
            <section className="mb-4">
              <h3 className="mb-1.5 text-[11px] font-medium tracking-[2px] text-ink-faint">
                BROWSER
              </h3>
              <p className="text-[12px] text-ink-ghost">
                No browser tools yet — session screens will show here.
              </p>
            </section>

            <section>
              <h3 className="mb-1.5 text-[11px] font-medium tracking-[2px] text-ink-faint">
                RECENT ACTIVITY
              </h3>
              {logsQuery.isError && (
                <p className="text-[13px] text-ink-muted">Could not load logs.</p>
              )}
              {logsQuery.data && logsQuery.data.length === 0 && (
                <p className="text-[13px] text-ink-muted">No recent logs.</p>
              )}
              {logsQuery.data && logsQuery.data.length > 0 && (
                <ul className="space-y-2">
                  {logsQuery.data.map((log) => {
                    const line = formatLogLine(log);
                    return (
                      <li key={log.id} className="text-[12px] leading-snug">
                        <span className="mr-1.5 text-[10px] tracking-wide text-ink-ghost">
                          {log.event}
                        </span>
                        <span
                          className={
                            line.error ? "text-ink" : "text-ink-muted"
                          }
                          style={
                            line.error
                              ? { color: "var(--sage-deep)" }
                              : undefined
                          }
                        >
                          {line.error ? "error · " : ""}
                          {line.text}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}

        {detailQuery.isLoading && (
          <p className="text-[13px] text-ink-muted">Loading…</p>
        )}
      </div>
    </div>
  );
}
