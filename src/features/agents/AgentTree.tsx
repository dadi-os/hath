import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { dimaag, isMeshOnline, nas } from "../../shared/api";
import type { AgentRecord } from "../../shared/api/types";
import { useConnection } from "../../hooks/useConnection";
import { AGENTS_QUERY_KEY } from "../../hooks/useEvents";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";
import { POLL_MS } from "../../shared/lib/ux/poll";
import { openAgent } from "../../store/chat";
import { getRunning, seedRunningFromAgents, subscribeRunning } from "../../store/running";
import { AgentPopover } from "./AgentPopover";
import {
  pickLiveBrowser,
  pickLiveTerminal,
} from "./sessions";
import {
  buildTree,
  isLiveVisual,
  layoutCircle,
  labelPlacement,
  linkPath,
  visualState,
  type LaidOutNode,
  type NodeVisual,
} from "./tree";

const DETAIL_DELAY_MS = 160;
const DETAIL_CLOSE_MS = 320;

type ViewTransform = { x: number; y: number; k: number };

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
 * Core glyph for an agent node — always a disc; fill weight carries the lane
 * (solid = conversation, soft = reasoning, solid + bone core = both).
 */
function AgentNodeCore({
  visual,
  r,
  className,
  delay,
}: {
  visual: NodeVisual;
  r: number;
  className: string;
  delay: number;
}) {
  const enter = {
    initial: { opacity: 0, scale: 0 },
    animate: { opacity: 1, scale: 1 },
    transition: { duration: SLOW_S, ease: EASE, delay },
  };

  if (visual === "both") {
    return (
      <g>
        <motion.circle className={className} r={r} {...enter} />
        <motion.circle
          className="agent-node__core-inset"
          r={r * 0.42}
          initial={{ opacity: 0, scale: 0 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: SLOW_S, ease: EASE, delay: delay + 0.04 }}
        />
      </g>
    );
  }

  return <motion.circle className={className} r={r} {...enter} />;
}

export type AgentTreeProps = {
  mode: "preview" | "full";
  entranceKey: string;
  className?: string;
  hideLabels?: boolean;
};

/**
 * Live agent ring. Roots sit on a circle; children step outward.
 * Hover opens details. Click opens the agent in the sidebar.
 */
export function AgentTree({
  mode,
  entranceKey,
  className,
  hideLabels = false,
}: AgentTreeProps) {
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);
  const runningMap = useSyncExternalStore(subscribeRunning, getRunning, getRunning);
  const interactive = mode === "full";
  const preview = mode === "preview";

  const spacingX = preview ? 72 : 120;
  const spacingY = preview ? 64 : 96;
  const viewPad = preview ? 36 : 48;
  const rIdle = preview ? 3.25 : 4.5;
  const rDormant = preview ? 2.25 : 3;
  /** Floor so sparse trees do not balloon to fill the widget. */
  const minViewW = preview ? 200 : 320;
  const minViewH = preview ? 150 : 240;

  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: async () => {
      const { agents } = await dimaag.listAgents();
      seedRunningFromAgents(agents);
      return agents;
    },
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const browsersQuery = useQuery({
    queryKey: ["nas", "browsers"],
    queryFn: () => nas.listBrowsers(),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const terminalsQuery = useQuery({
    queryKey: ["nas", "terminals"],
    queryFn: () => nas.listTerminals(),
    enabled: connected,
    refetchInterval: POLL_MS,
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
    const forest = buildTree(agents);
    if (forest.length === 0) {
      return null;
    }
    const ring = Math.max(
      preview ? 108 : 168,
      (forest.length * spacingX) / (Math.PI * 2),
    );
    const laid = layoutCircle(forest, ring, spacingY * 0.82);
    const nodes = laid.nodes;
    let minX = 0;
    let maxX = 0;
    let minY = 0;
    let maxY = 0;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }
    const contentW = Math.max(maxX - minX, 0);
    const contentH = Math.max(maxY - minY, 0);
    const labelPad = hideLabels ? 0 : preview ? 20 : 44;
    const w = Math.max(contentW + (viewPad + labelPad) * 2, minViewW);
    const h = Math.max(contentH + (viewPad + labelPad) * 2, minViewH);
    return {
      nodes,
      links: laid.links,
      viewBox: {
        x: minX - (w - contentW) / 2,
        y: minY - (h - contentH) / 2,
        w,
        h,
      },
    };
  }, [agents, spacingX, spacingY, viewPad, hideLabels, minViewW, minViewH, preview]);

  const knownIdsRef = useRef<Set<string>>(new Set());
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    knownIdsRef.current = new Set();
    bootstrappedRef.current = false;
  }, [entranceKey]);

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
  const rootRef = useRef<HTMLDivElement>(null);
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
  const detailTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearDetailTimer = () => {
    if (detailTimerRef.current !== null) {
      window.clearTimeout(detailTimerRef.current);
      detailTimerRef.current = null;
    }
  };

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const hideDetails = () => {
    clearDetailTimer();
    clearCloseTimer();
    setSelectedId(null);
    setAnchor(null);
  };

  useEffect(() => () => {
    clearDetailTimer();
    clearCloseTimer();
  }, []);

  useEffect(() => {
    setView({ x: 0, y: 0, k: 1 });
    hideDetails();
  }, [entranceKey]);

  const resetView = () => setView({ x: 0, y: 0, k: 1 });

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!interactive || e.button !== 0) {
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
    if (!interactive) {
      return;
    }
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
    hideDetails();
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
    if (!interactive) {
      return;
    }
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
    if (!interactive) {
      return;
    }
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
    if (!interactive || e.touches.length !== 2 || !pinchRef.current || !svgRef.current) {
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

  const nodeScreenAnchor = (node: LaidOutNode) => {
    const svg = svgRef.current;
    const root = rootRef.current;
    if (!svg || !root) {
      return null;
    }
    const pt = svg.createSVGPoint();
    pt.x = node.x * view.k + view.x;
    pt.y = node.y * view.k + view.y;
    const ctm = svg.getScreenCTM();
    if (!ctm) {
      return null;
    }
    const screen = pt.matrixTransform(ctm);
    const rect = root.getBoundingClientRect();
    return { x: screen.x - rect.left, y: screen.y - rect.top };
  };

  /** After a short delay, open the detail panel for this node. */
  const scheduleDetails = (node: LaidOutNode) => {
    if (dragRef.current.active) {
      return;
    }
    clearCloseTimer();
    if (selectedId === node.data.id) {
      return;
    }
    clearDetailTimer();
    detailTimerRef.current = window.setTimeout(() => {
      if (dragRef.current.active) {
        return;
      }
      setSelectedId(node.data.id);
      setAnchor(nodeScreenAnchor(node));
    }, DETAIL_DELAY_MS);
  };

  const scheduleClose = () => {
    clearDetailTimer();
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setSelectedId(null);
      setAnchor(null);
    }, DETAIL_CLOSE_MS);
  };

  const movePopoverToAgent = (agentId: string) => {
    clearCloseTimer();
    setSelectedId(agentId);
    const node = layout?.nodes.find((n) => n.data.id === agentId);
    if (!node) {
      return;
    }
    const anchorPt = nodeScreenAnchor(node);
    if (anchorPt) {
      setAnchor(anchorPt);
    }
  };

  if (!connected) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">Connect to load agents</p>
      </div>
    );
  }

  if (agentsQuery.isError) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-muted">Could not load agents.</p>
      </div>
    );
  }

  if (!agents) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-muted">Loading agents…</p>
      </div>
    );
  }

  if (agents.length === 0 || !layout) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-muted">No agents yet</p>
      </div>
    );
  }

  const { viewBox } = layout;
  const detailAgent = selectedId ? agentsById.get(selectedId) : undefined;
  const detailBrowserId =
    detailAgent && browsersQuery.isSuccess
      ? pickLiveBrowser(detailAgent.sessions.browsers, browsersQuery.data)
      : null;
  const detailTerminal =
    detailAgent && terminalsQuery.isSuccess
      ? pickLiveTerminal(detailAgent.sessions.terminals, terminalsQuery.data)
      : null;

  return (
    <div ref={rootRef} className={`relative h-full min-h-0 w-full ${className ?? ""}`}>
      <svg
        key={entranceKey}
        ref={svgRef}
        className={`h-full w-full ${interactive ? "touch-none cursor-grab active:cursor-grabbing" : ""}`}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={interactive ? onWheel : undefined}
        onDoubleClick={interactive ? resetView : undefined}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {layout.links.map((link, i) => (
            <motion.path
              key={`${link.source.data.id}-${link.target.data.id}`}
              className="agent-tree__link"
              d={linkPath(link)}
              strokeWidth={preview ? 0.9 : 1.05}
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.55 }}
              transition={{
                duration: SLOW_S,
                ease: EASE,
                delay: Math.min(i * 0.015, 0.12),
              }}
            />
          ))}

          {layout.nodes.map((node) => {
            const agent = agentsById.get(node.data.id);
            if (!agent) {
              return null;
            }
            const visual = visualState(agent, runningMap[agent.id]);
            const selected = selectedId === agent.id;
            const live = isLiveVisual(visual);
            const r = visual === "dormant" ? rDormant : rIdle;
            const depth = node.depth;
            const delay = Math.min(depth * 0.03, 0.18);
            const coreClass = [
              "agent-node__core",
              `agent-node__core--${visual}`,
              selected ? "is-selected" : "",
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <g
                key={agent.id}
                className="agent-node"
                transform={`translate(${node.x},${node.y})`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                }}
                onPointerEnter={() => {
                  scheduleDetails(node);
                }}
                onPointerLeave={() => {
                  scheduleClose();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (interactive && dragRef.current.moved) {
                    return;
                  }
                  hideDetails();
                  openAgent(agent.id);
                }}
              >
                <circle className="agent-node__hit" r={r + 10} />

                {live ? (
                  <>
                    <circle className="agent-node__glow" r={r * 1.55} />
                    <circle className="agent-node__halo" r={r * 1.65} />
                    <circle
                      className="agent-node__halo agent-node__halo--delay"
                      r={r * 1.65}
                    />
                  </>
                ) : null}

                <AgentNodeCore
                  visual={visual}
                  r={r}
                  className={coreClass}
                  delay={delay}
                />

                {!hideLabels ? (
                  <motion.text
                    className={[
                      "agent-node__label",
                      visual === "dormant" ? "is-dormant" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    {...labelPlacement(node, layout.links, preview ? 14 : 20)}
                    fontSize={preview ? 7 : 9.5}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{
                      duration: SLOW_S,
                      ease: EASE,
                      delay: delay + 0.04,
                    }}
                  >
                    {agent.name}
                  </motion.text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>

      <AgentPopover
        open={selectedId !== null && anchor !== null}
        agentId={selectedId}
        agentsById={agentsById}
        runningMap={runningMap}
        anchor={anchor}
        containerRef={rootRef as RefObject<HTMLElement | null>}
        browserId={detailBrowserId}
        terminal={detailTerminal}
        onHoverStart={clearCloseTimer}
        onHoverEnd={scheduleClose}
        onClose={hideDetails}
        onSelectParent={movePopoverToAgent}
      />
    </div>
  );
}
