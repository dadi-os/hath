import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
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
import { AgentGraph3D } from "./AgentGraph3D";
import { AgentPopover } from "./AgentPopover";
import { pickLiveBrowser, pickLiveTerminal } from "./sessions";
import {
  buildTree,
  isLiveVisual,
  labelPlacement,
  layoutForest3d,
  linkPath,
  projectForest2d,
  visualState,
  type LaidOutNode,
  type NodeVisual,
} from "./tree";

const DETAIL_DELAY_MS = 160;
const DETAIL_CLOSE_MS = 320;

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
 * Agents surface: full page is a 3D forest; home preview is a cheap SVG projection.
 */
export function AgentTree({
  mode,
  entranceKey,
  className,
  hideLabels = false,
}: AgentTreeProps) {
  if (mode === "full") {
    return <AgentGraph3D entranceKey={entranceKey} className={className} />;
  }
  return (
    <AgentTreePreview
      entranceKey={entranceKey}
      className={className}
      hideLabels={hideLabels}
    />
  );
}

/**
 * Non-WebGL home-tile preview of the agent forest (XZ projected to SVG).
 */
function AgentTreePreview({
  entranceKey,
  className,
  hideLabels,
}: {
  entranceKey: string;
  className?: string;
  hideLabels: boolean;
}) {
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);
  const runningMap = useSyncExternalStore(subscribeRunning, getRunning, getRunning);

  const spacingX = 72;
  const spacingY = 64;
  const viewPad = 36;
  const rIdle = 3.25;
  const rDormant = 2.25;
  const minViewW = 200;
  const minViewH = 150;

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
    const laid = projectForest2d(layoutForest3d(forest, spacingX * 0.55, spacingY * 0.82));
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
    const labelPad = hideLabels ? 0 : 20;
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
  }, [agents, hideLabels]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
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
    hideDetails();
  }, [entranceKey]);

  const nodeScreenAnchor = (node: LaidOutNode) => {
    const svg = svgRef.current;
    const root = rootRef.current;
    if (!svg || !root) {
      return null;
    }
    const pt = svg.createSVGPoint();
    pt.x = node.x;
    pt.y = node.y;
    const ctm = svg.getScreenCTM();
    if (!ctm) {
      return null;
    }
    const screen = pt.matrixTransform(ctm);
    const rect = root.getBoundingClientRect();
    return { x: screen.x - rect.left, y: screen.y - rect.top };
  };

  const scheduleDetails = (node: LaidOutNode) => {
    clearCloseTimer();
    if (selectedId === node.data.id) {
      return;
    }
    clearDetailTimer();
    detailTimerRef.current = window.setTimeout(() => {
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
        className="h-full w-full"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <g>
          {layout.links.map((link, i) => (
            <motion.path
              key={`${link.source.data.id}-${link.target.data.id}`}
              className="agent-tree__link"
              d={linkPath(link)}
              strokeWidth={0.9}
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
              throw new Error(`layout node missing agent record: ${node.data.id}`);
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
                onPointerEnter={() => {
                  scheduleDetails(node);
                }}
                onPointerLeave={() => {
                  scheduleClose();
                }}
                onClick={(e) => {
                  e.stopPropagation();
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
                    {...labelPlacement(node, layout.links, 14)}
                    fontSize={7}
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
