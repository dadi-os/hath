import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { isMeshOnline, yaad } from "../../shared/api";
import type { NodeKind } from "../../shared/api/types";
import { useConnection } from "../../hooks/useConnection";
import { ForceGraph, syncForceSimulation } from "../../shared/components/ForceGraph";
import { GraphSpace } from "../../shared/components/GraphSpace";
import { Popover } from "../../shared/components/Popover";
import { POLL_MS } from "../../shared/lib/ux/poll";
import { createMemorySimulation, mergeGraph, nodeRadius, truncate, type GraphData } from "./graph";

const KIND_COLOR: Record<NodeKind, string> = {
  person: "#5c6b52",
  place: "#8fa382",
  memory: "#aebda1",
  plan: "#c4ad7c",
};
/** Most-connected nodes that keep a label when nothing is selected. */
const HUB_LABELS = 12;
const EMPTY: GraphData = { nodes: [], edges: [] };

export type MemoryGraph3DProps = {
  /** Changes on each arrival at the page; resets the simulation, expansions, and selection. */
  entranceKey: string;
  /** Extra classes on the root element. */
  className?: string;
};

/**
 * Full-page Yaad knowledge network — a live 3D force-directed graph.
 * Polls `POST /graph`; new nodes sprout from the node they attach to and the
 * layout relaxes around them. "Expand neighbors" grows the network from a node.
 */
export function MemoryGraph3D({ entranceKey, className }: MemoryGraph3DProps) {
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);
  const rootRef = useRef<HTMLDivElement>(null);

  const [expansions, setExpansions] = useState<GraphData>(EMPTY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const ambientQuery = useQuery({
    queryKey: ["yaad", "graph", entranceKey],
    queryFn: () => yaad.graph({}),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const expand = useMutation({
    mutationFn: (id: string) => yaad.graph({ seed_ids: [id] }),
    onSuccess: (res) => setExpansions((prev) => mergeGraph(prev, res)),
  });

  useEffect(() => {
    setExpansions(EMPTY);
    setSelectedId(null);
    setAnchor(null);
  }, [entranceKey]);

  const sim = useMemo(() => createMemorySimulation(), [entranceKey]);

  const graph = useMemo(() => {
    const data = ambientQuery.data ? mergeGraph(expansions, ambientQuery.data) : expansions;
    return syncForceSimulation(sim, data.nodes, data.edges);
  }, [sim, ambientQuery.data, expansions]);

  const hubs = useMemo(
    () =>
      new Set(
        [...graph.nodes]
          .filter((n) => n.degree > 0)
          .sort((a, b) => b.degree - a.degree)
          .slice(0, HUB_LABELS)
          .map((n) => n.id),
      ),
    [graph.nodes],
  );

  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;

  if (!connected) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">Connect to load memory</p>
      </div>
    );
  }

  if (ambientQuery.isError) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-muted">
          Could not load memory: {ambientQuery.error.message}
        </p>
      </div>
    );
  }

  if (ambientQuery.isPending) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">Loading memory…</p>
      </div>
    );
  }

  if (graph.nodes.length === 0) {
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
      <GraphSpace key={entranceKey} interactive cameraPosition={[0, 60, 220]}>
        <ForceGraph
          sim={sim}
          graph={graph}
          selectedId={selectedId}
          radius={(n) => nodeRadius(n.kind, n.degree)}
          look={(n, { selected: isSelected, dimmed }) => ({
            color: KIND_COLOR[n.kind],
            opacity: dimmed ? 0.22 : 1,
            emissiveIntensity: isSelected ? 0.5 : 0.12,
            wireframe: false,
          })}
          labelText={(n) => truncate(n.title, 32)}
          pinnedLabels={hubs}
          onNodeClick={(node, at) => {
            expand.reset();
            setSelectedId(node.id);
            setAnchor(at);
          }}
        />
      </GraphSpace>

      <div className="pointer-events-none absolute bottom-3 left-3 flex gap-3 text-[10px] font-medium tracking-[1.5px] uppercase text-ink-muted">
        {(Object.keys(KIND_COLOR) as NodeKind[]).map((kind) => (
          <span key={kind} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: KIND_COLOR[kind] }} />
            {kind}
          </span>
        ))}
        <span className="text-ink-ghost">
          {graph.nodes.length} nodes · {graph.links.length} links
        </span>
      </div>

      <Popover
        open={selected !== null && anchor !== null}
        aria-label={selected ? selected.title : "Node"}
        anchor={anchor === null ? { x: 0, y: 0 } : anchor}
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
            <p className="text-[11px] text-ink-ghost">
              {selected.degree} {selected.degree === 1 ? "link" : "links"}
            </p>
            <button
              type="button"
              disabled={expand.isPending}
              onClick={() => expand.mutate(selected.id)}
              className="mt-1 self-start rounded-[6px] border border-dashed border-sage-line bg-sage-fill px-2.5 py-1 text-[11px] font-medium tracking-wide text-sage-deep transition-colors duration-slow ease-hath hover:bg-sage-active disabled:opacity-50"
            >
              {expand.isPending ? "Expanding…" : "Expand neighbors"}
            </button>
            {expand.isError ? (
              <p className="text-[11px] text-error">Could not expand: {expand.error.message}</p>
            ) : null}
          </div>
        ) : null}
      </Popover>
    </div>
  );
}
