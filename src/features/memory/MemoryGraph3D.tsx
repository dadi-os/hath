import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { isMeshOnline, yaad } from "../../shared/api";
import type { NodeKind } from "../../shared/api/types";
import { useConnection } from "../../hooks/useConnection";
import { useHoverDetails } from "../../hooks/useHoverDetails";
import { useThemeTokens } from "../../hooks/useThemeTokens";
import { ForceGraph, syncForceSimulation } from "../../shared/components/ForceGraph";
import { GraphSearch } from "../../shared/components/GraphSearch";
import { GraphSpace } from "../../shared/components/GraphSpace";
import { Popover } from "../../shared/components/Popover";
import { POLL_MS } from "../../shared/lib/ux/poll";
import { createMemorySimulation, mergeGraph, nodeRadius, truncate, type GraphData } from "./graph";

/** Theme token that colors each node kind, in the scene and the legend. */
const KIND_TOKEN = {
  person: "--sage-deep",
  place: "--sage",
  memory: "--ink-faint",
  plan: "--clay",
} as const satisfies Record<NodeKind, string>;
const KIND_TOKENS = Object.values(KIND_TOKEN);
const EMPTY: GraphData = { nodes: [], edges: [] };

export type MemoryGraph3DProps = {
  /** Changes on each arrival at the page; resets the simulation, search, and selection. */
  entranceKey: string;
  /** Extra classes on the root element. */
  className?: string;
};

/**
 * Full-page Yaad knowledge network — a live 3D force-directed graph.
 * Polls `POST /graph`; new nodes sprout from the node they attach to and the
 * layout relaxes around them. Every non-memory node is labelled; the search box
 * narrows to matching titles and flies to a lone match.
 */
export function MemoryGraph3D({ entranceKey, className }: MemoryGraph3DProps) {
  const { state: connection } = useConnection();
  const theme = useThemeTokens(KIND_TOKENS);
  const connected = isMeshOnline(connection);
  const rootRef = useRef<HTMLDivElement>(null);

  const details = useHoverDetails(entranceKey);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const ambientQuery = useQuery({
    queryKey: ["yaad", "graph", entranceKey],
    queryFn: () => yaad.graph({}),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  useEffect(() => {
    setFocusId(null);
    setQuery("");
  }, [entranceKey]);

  const clearFocus = () => {
    details.close();
    setFocusId(null);
  };

  const sim = useMemo(() => createMemorySimulation(), [entranceKey]);

  const graph = useMemo(() => {
    const data = ambientQuery.data ? mergeGraph(EMPTY, ambientQuery.data) : EMPTY;
    return syncForceSimulation(sim, data.nodes, data.edges);
  }, [sim, ambientQuery.data]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? new Set(graph.nodes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id))
      : null;
  }, [graph.nodes, query]);
  const onlyMatch = matches?.size === 1 ? [...matches][0]! : null;

  const pinnedLabels = useMemo(
    () => new Set(graph.nodes.filter((n) => n.kind !== "memory").map((n) => n.id)),
    [graph.nodes],
  );

  const revealSeeds = useMemo(
    () =>
      new Set(
        graph.nodes.filter((n) => n.kind === "person" || n.kind === "place").map((n) => n.id),
      ),
    [graph.nodes],
  );

  const selected = graph.nodes.find((n) => n.id === details.id) ?? null;

  if (!connected) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">Connect to load Yaad</p>
      </div>
    );
  }

  if (ambientQuery.isError) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-muted">
          Could not load Yaad: {ambientQuery.error.message}
        </p>
      </div>
    );
  }

  if (ambientQuery.isPending) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">Loading Yaad…</p>
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
      <GraphSpace
        key={entranceKey}
        interactive
        cameraPosition={[0, 60, 260]}
        onBackgroundClick={clearFocus}
      >
        <ForceGraph
          sim={sim}
          graph={graph}
          focusId={focusId ?? onlyMatch}
          hold={details.id !== null || focusId !== null || matches !== null}
          matches={matches}
          radius={(n) => nodeRadius(n.kind, n.degree)}
          look={(n) => ({
            color: theme[KIND_TOKEN[n.kind]],
            opacity: 1,
            emissiveIntensity: 0.12,
            wireframe: false,
          })}
          labelText={(n) => truncate(n.title, 32)}
          pinnedLabels={pinnedLabels}
          revealSeeds={revealSeeds}
          edgeLabel={(link) => link.type.replace(/_/g, " ")}
          onNodeHover={(node, at) => details.hover(node.id, at)}
          onNodeLeave={details.leave}
          onNodeClick={(node) => {
            details.close();
            setFocusId(node.id);
          }}
          onFocusArrive={(node, at) => {
            if (node.id === focusId) {
              details.pin(node.id, at);
            }
          }}
        />
      </GraphSpace>

      <GraphSearch
        value={query}
        onChange={setQuery}
        placeholder="Search Yaad"
        matches={matches === null ? null : matches.size}
        onPick={() => {
          if (onlyMatch) {
            details.close();
            setFocusId(onlyMatch);
          }
        }}
      />

      <div className="pointer-events-none absolute bottom-3 left-3 flex gap-3 text-[10px] font-medium tracking-[1.5px] uppercase text-ink-muted">
        {(Object.keys(KIND_TOKEN) as NodeKind[]).map((kind) => (
          <span key={kind} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: `var(${KIND_TOKEN[kind]})` }} />
            {kind}
          </span>
        ))}
        <span className="text-ink-ghost">
          {graph.nodes.length} nodes · {graph.links.length} links
        </span>
      </div>

      <Popover
        open={selected !== null && details.anchor !== null}
        aria-label={selected ? selected.title : "Node"}
        anchor={details.anchor ?? { x: 0, y: 0 }}
        containerRef={rootRef as RefObject<HTMLElement | null>}
        onClose={clearFocus}
        onMouseEnter={details.keep}
        onMouseLeave={details.leave}
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
          </div>
        ) : null}
      </Popover>
    </div>
  );
}
