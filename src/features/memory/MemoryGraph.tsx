import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { motion } from "motion/react";
import { yaad } from "../../shared/api";
import type { EdgeRecord, NodeKind } from "../../shared/api/types";
import { useConnection } from "../../hooks/useConnection";
import { Popover } from "../../shared/components/Popover";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";
import { POLL_MS } from "../../shared/lib/ux/poll";
import {
  mergeGraph,
  nodeRadius,
  truncate,
  type GraphData,
  type GraphEdge,
  type GraphNode,
} from "./graph";

type ViewTransform = { x: number; y: number; k: number };

type SimNode = GraphNode & SimulationNodeDatum;
type SimLink = GraphEdge & SimulationLinkDatum<SimNode>;

export type MemoryGraphProps = {
  mode: "full" | "preview";
  entranceKey: string;
  className?: string;
};

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

function kindClass(kind: NodeKind): string {
  return `memory-node__core memory-node__core--${kind}`;
}

async function seedAmbient(preview: boolean): Promise<GraphData> {
  const cap = preview ? 18 : 40;
  const hubLimit = preview ? 4 : 8;
  const now = Date.now();
  const from = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now + 1 * 24 * 60 * 60 * 1000).toISOString();

  const [people, places, memories] = await Promise.all([
    yaad.query({ kind: "person", limit: preview ? 8 : 16 }),
    yaad.query({ kind: "place", limit: preview ? 6 : 12 }),
    yaad.query({
      kind: "memory",
      occurred_from: from,
      occurred_to: to,
      limit: preview ? 10 : 20,
    }),
  ]);

  const nodes: GraphNode[] = [
    ...people.nodes,
    ...places.nodes,
    ...memories.nodes,
  ].map((n) => ({ ...n, detail: n.detail }));

  let data: GraphData = { nodes: [], edges: [] };
  data = mergeGraph(data, { nodes, edges: [] }, cap);

  const hubs = data.nodes
    .filter((n) => n.kind === "person" || n.kind === "place")
    .slice(0, hubLimit);

  const expansions = await Promise.all(
    hubs.map(async (h) => {
      const full = await yaad.getNode(h.id);
      const neighborIds = [
        ...full.edges.outgoing.map((e) => e.dst_id),
        ...full.edges.incoming.map((e) => e.src_id),
      ];
      const unique = [...new Set(neighborIds)].filter((id) => id !== h.id);
      const neighborNodes: GraphNode[] = [];
      for (const id of unique.slice(0, preview ? 3 : 5)) {
        if (data.nodes.some((n) => n.id === id)) {
          continue;
        }
        try {
          const n = await yaad.getNode(id);
          if (n.kind === "person" || n.kind === "memory" || n.kind === "place") {
            neighborNodes.push(n);
          }
        } catch {
          // Skip missing / failed neighbors.
        }
      }
      const edges: EdgeRecord[] = [
        ...full.edges.outgoing,
        ...full.edges.incoming,
      ];
      return { nodes: [full, ...neighborNodes], edges };
    }),
  );

  for (const exp of expansions) {
    data = mergeGraph(data, exp, cap);
  }

  return data;
}

/**
 * Yaad knowledge graph: force layout, expand via getNode.
 */
export function MemoryGraph({
  mode,
  entranceKey,
  className,
}: MemoryGraphProps) {
  const { state: connection } = useConnection();
  const connected = connection === "connected";
  const preview = mode === "preview";
  const cap = preview ? 18 : 40;

  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });
  const [simNodes, setSimNodes] = useState<SimNode[]>([]);
  const [simLinks, setSimLinks] = useState<SimLink[]>([]);
  const [view, setView] = useState<ViewTransform>({ x: 0, y: 0, k: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [expanding, setExpanding] = useState(false);

  const svgRef = useRef<SVGSVGElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({
    active: false,
    moved: false,
    lastX: 0,
    lastY: 0,
    pointerId: null as number | null,
  });
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode, SimLink>> | null>(
    null,
  );

  const ambientQuery = useQuery({
    queryKey: ["yaad", "memory-ambient", preview ? "preview" : "full", entranceKey],
    queryFn: () => seedAmbient(preview),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  useEffect(() => {
    if (ambientQuery.data) {
      setGraph(ambientQuery.data);
    }
  }, [ambientQuery.data]);

  useEffect(() => {
    setView({ x: 0, y: 0, k: 1 });
    setSelectedId(null);
    setAnchor(null);
  }, [entranceKey]);

  // Force simulation
  useEffect(() => {
    simRef.current?.stop();
    if (graph.nodes.length === 0) {
      setSimNodes([]);
      setSimLinks([]);
      return;
    }

    const nodes: SimNode[] = graph.nodes.map((n) => ({ ...n }));
    const links: SimLink[] = graph.edges.map((e) => ({ ...e }));

    const sim = forceSimulation<SimNode, SimLink>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(preview ? 42 : 64)
          .strength(0.45),
      )
      .force("charge", forceManyBody().strength(preview ? -80 : -140))
      .force("center", forceCenter(0, 0))
      .force(
        "collide",
        forceCollide<SimNode>()
          .radius((d) => nodeRadius(d.kind, preview) + 4)
          .strength(0.8),
      )
      .alpha(0.9)
      .alphaDecay(0.028);

    simRef.current = sim;

    const publish = () => {
      setSimNodes(nodes.map((n) => ({ ...n })));
      setSimLinks(links.map((l) => ({ ...l })));
    };
    sim.on("tick", publish);
    for (let i = 0; i < 60; i++) {
      sim.tick();
    }
    publish();

    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [graph, preview]);

  const selected = useMemo(
    () => simNodes.find((n) => n.id === selectedId) ?? null,
    [simNodes, selectedId],
  );

  const bounds = useMemo(() => {
    if (simNodes.length === 0) {
      return { x: -80, y: -60, w: 160, h: 120 };
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of simNodes) {
      const r = nodeRadius(n.kind, preview) + 16;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      minX = Math.min(minX, x - r);
      maxX = Math.max(maxX, x + r);
      minY = Math.min(minY, y - r);
      maxY = Math.max(maxY, y + r);
    }
    const pad = preview ? 24 : 48;
    return {
      x: minX - pad,
      y: minY - pad,
      w: Math.max(maxX - minX + pad * 2, 120),
      h: Math.max(maxY - minY + pad * 2, 100),
    };
  }, [simNodes, preview]);

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
    if (!svg) {
      return;
    }
    const rect = svg.getBoundingClientRect();
    const scaleX = bounds.w / rect.width;
    const scaleY = bounds.h / rect.height;
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
    if (preview) {
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
      const k = Math.min(4, Math.max(0.35, v.k * factor));
      return {
        k,
        x: pt.x - ((pt.x - v.x) / v.k) * k,
        y: pt.y - ((pt.y - v.y) / v.k) * k,
      };
    });
  };

  const openNode = (
    node: SimNode,
    clientX: number,
    clientY: number,
  ) => {
    setSelectedId(node.id);
    const root = rootRef.current;
    if (!root) {
      setAnchor({ x: clientX, y: clientY });
      return;
    }
    const rect = root.getBoundingClientRect();
    setAnchor({ x: clientX - rect.left, y: clientY - rect.top });
  };

  const expandSelected = useCallback(async () => {
    if (!selectedId) {
      return;
    }
    setExpanding(true);
    try {
      const full = await yaad.getNode(selectedId);
      const neighborIds = [
        ...full.edges.outgoing.map((e) => e.dst_id),
        ...full.edges.incoming.map((e) => e.src_id),
      ];
      const unique = [...new Set(neighborIds)].filter((id) => id !== selectedId);
      const neighborNodes: GraphNode[] = [];
      for (const id of unique.slice(0, 8)) {
        if (graph.nodes.some((n) => n.id === id)) {
          continue;
        }
        try {
          const n = await yaad.getNode(id);
          neighborNodes.push(n);
        } catch {
          // skip
        }
      }
      setGraph((prev) =>
        mergeGraph(
          prev,
          {
            nodes: [full, ...neighborNodes],
            edges: [...full.edges.outgoing, ...full.edges.incoming],
          },
          cap,
        ),
      );
    } finally {
      setExpanding(false);
    }
  }, [selectedId, graph.nodes, cap]);

  const loading = ambientQuery.isLoading;
  const errored = ambientQuery.isError;

  if (!connected) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">Connect to load memory</p>
      </div>
    );
  }

  if (errored) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-muted">Could not load memory.</p>
      </div>
    );
  }

  if (loading && graph.nodes.length === 0) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">Loading memory…</p>
      </div>
    );
  }

  if (!loading && graph.nodes.length === 0) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="px-4 text-center text-[13px] text-ink-ghost">
          No people, places, or memories yet
        </p>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`relative h-full min-h-0 w-full ${className ?? ""}`}>
      <svg
        key={entranceKey}
        ref={svgRef}
        className={`h-full w-full touch-none ${preview ? "" : "cursor-grab active:cursor-grabbing"}`}
        viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={preview ? undefined : onWheel}
        onDoubleClick={preview ? undefined : resetView}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {simLinks.map((link, i) => {
            const s = link.source as SimNode;
            const t = link.target as SimNode;
            const x1 = s.x ?? 0;
            const y1 = s.y ?? 0;
            const x2 = t.x ?? 0;
            const y2 = t.y ?? 0;
            return (
              <motion.line
                key={link.id}
                className="memory-link"
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                strokeOpacity={0.25 + link.confidence * 0.45}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{
                  duration: SLOW_S,
                  ease: EASE,
                  delay: Math.min(i * 0.01, 0.12),
                }}
              />
            );
          })}

          {simNodes.map((node, i) => {
            const r = nodeRadius(node.kind, preview);
            const x = node.x ?? 0;
            const y = node.y ?? 0;
            const selected = node.id === selectedId;
            return (
              <g
                key={node.id}
                className="memory-node"
                transform={`translate(${x},${y})`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (preview || dragRef.current.moved) {
                    return;
                  }
                  openNode(node, e.clientX, e.clientY);
                }}
              >
                <circle className="memory-node__hit" r={r + 10} />
                <motion.circle
                  className={`${kindClass(node.kind)}${selected ? " is-selected" : ""}`}
                  initial={{ r: 0, opacity: 0 }}
                  animate={{ r, opacity: 1 }}
                  transition={{
                    duration: SLOW_S,
                    ease: EASE,
                    delay: Math.min(i * 0.02, 0.2),
                  }}
                />
                {!preview ? (
                  <text
                    className="memory-node__label"
                    y={r + 12}
                    textAnchor="middle"
                  >
                    {node.title.length > 18
                      ? `${node.title.slice(0, 17)}…`
                      : node.title}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>

      <Popover
        open={selected !== null && anchor !== null && !preview}
        aria-label={selected?.title ?? "Node"}
        anchor={anchor ?? { x: 0, y: 0 }}
        containerRef={rootRef as RefObject<HTMLElement | null>}
        onClose={() => {
          setSelectedId(null);
          setAnchor(null);
        }}
        widthPx={300}
      >
        {selected ? (
          <div className="flex flex-col gap-2 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[14px] text-ink">{selected.title}</span>
              <span className="shrink-0 text-[10px] font-medium tracking-[1.5px] uppercase text-sage-text">
                {selected.kind}
              </span>
            </div>
            {selected.body ? (
              <p className="text-[12px] leading-relaxed text-ink-muted">
                {truncate(selected.body, 180)}
              </p>
            ) : null}
            {selected.occurred_at ? (
              <p className="text-[11px] text-ink-ghost">
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(selected.occurred_at))}
              </p>
            ) : null}
            <button
              type="button"
              disabled={expanding}
              onClick={() => void expandSelected()}
              className="mt-1 self-start rounded-[6px] border border-dashed border-sage-line bg-sage-fill px-2.5 py-1 text-[11px] font-medium tracking-wide text-sage-deep transition-colors duration-slow ease-hath hover:bg-sage-active disabled:opacity-50"
            >
              {expanding ? "Expanding…" : "Expand neighbors"}
            </button>
          </div>
        ) : null}
      </Popover>
    </div>
  );
}
