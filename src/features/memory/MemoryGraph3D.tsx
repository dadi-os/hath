import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useThree } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import { useQuery } from "@tanstack/react-query";
import { isMeshOnline, yaad } from "../../shared/api";
import type { EdgeRecord, NodeKind } from "../../shared/api/types";
import { useConnection } from "../../hooks/useConnection";
import { GraphLabel } from "../../shared/components/GraphLabel";
import { GraphSpace } from "../../shared/components/GraphSpace";
import { Popover } from "../../shared/components/Popover";
import { POLL_MS } from "../../shared/lib/ux/poll";
import {
  layoutMemoryPlane3d,
  mergeGraph,
  nodeRadius,
  truncate,
  type GraphData,
  type GraphNode,
  type LaidOutMemoryNode,
} from "./graph";

const SAGE = "#8fa382";
const SAGE_DEEP = "#5c6b52";
const SAGE_LINE = "#b9c9ab";
const BONE = "#fafaf7";
const BONE_RAISED = "#f7f9f4";

export type MemoryGraph3DProps = {
  entranceKey: string;
  className?: string;
};

/** Kind → mesh fill for memory nodes. */
function kindColor(kind: NodeKind): string {
  if (kind === "person") {
    return "#c5d1ba";
  }
  if (kind === "place") {
    return BONE;
  }
  if (kind === "plan") {
    return BONE_RAISED;
  }
  return "#b5c4a8";
}

/** Kind → accent for selection / outline. */
function kindAccent(kind: NodeKind): string {
  if (kind === "person") {
    return SAGE_DEEP;
  }
  if (kind === "place") {
    return SAGE;
  }
  if (kind === "plan") {
    return SAGE_LINE;
  }
  return SAGE;
}

async function seedAmbient(): Promise<GraphData> {
  const cap = 40;
  const hubLimit = 8;
  const now = Date.now();
  const from = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now + 1 * 24 * 60 * 60 * 1000).toISOString();

  const [people, places, memories] = await Promise.all([
    yaad.query({ kind: "person", limit: 16 }),
    yaad.query({ kind: "place", limit: 12 }),
    yaad.query({
      kind: "memory",
      occurred_from: from,
      occurred_to: to,
      limit: 20,
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
      for (const id of unique.slice(0, 5)) {
        if (data.nodes.some((n) => n.id === id)) {
          continue;
        }
        const n = await yaad.getNode(id);
        if (n.kind === "person" || n.kind === "memory" || n.kind === "place") {
          neighborNodes.push(n);
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
 * Frame the camera above the XZ neighborhood plane.
 */
function FitCamera({ nodes }: { nodes: LaidOutMemoryNode[] }) {
  const { camera, controls } = useThree();
  const fittedKey = useRef("");

  useEffect(() => {
    if (nodes.length === 0) {
      return;
    }
    const key = nodes.map((n) => n.id).join(",");
    if (key === fittedKey.current) {
      return;
    }
    fittedKey.current = key;

    const box = new THREE.Box3();
    for (const n of nodes) {
      box.expandByPoint(new THREE.Vector3(n.x, n.y, n.z));
    }
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const span = Math.max(size.x, size.z, size.y * 1.2, 56);
    const dist = span * 1.25;

    // Elevated, slightly off-axis so the ground plane and heights both read.
    camera.position.set(
      center.x + dist * 0.35,
      center.y + dist * 0.85,
      center.z + dist * 0.55,
    );
    camera.near = 0.5;
    camera.far = Math.max(4000, dist * 10);
    camera.updateProjectionMatrix();
    camera.lookAt(center);

    const orbit = controls as { target: THREE.Vector3; update: () => void } | null;
    if (orbit?.target) {
      orbit.target.copy(center);
      orbit.update();
    }
  }, [nodes, camera, controls]);

  return null;
}

type MemoryNodeMeshProps = {
  node: LaidOutMemoryNode;
  selected: boolean;
  onSelect: (node: LaidOutMemoryNode, screen: { x: number; y: number }) => void;
};

/**
 * Single Yaad node mesh in the layered hierarchy.
 */
function MemoryNodeMesh({ node, selected, onSelect }: MemoryNodeMeshProps) {
  const { gl } = useThree();
  const base = nodeRadius(node.kind, false);
  const r = (node.depth === 0 ? base * 1.15 : base * 0.9) * 0.9;
  const title =
    node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title;

  return (
    <group position={[node.x, node.y, node.z]}>
      <mesh
        castShadow
        onClick={(e) => {
          e.stopPropagation();
          const rect = gl.domElement.getBoundingClientRect();
          onSelect(node, {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        }}
      >
        <sphereGeometry args={[r, 24, 24]} />
        <meshStandardMaterial
          color={kindColor(node.kind)}
          emissive={selected ? kindAccent(node.kind) : kindAccent(node.kind)}
          emissiveIntensity={selected ? 0.4 : 0.06}
          roughness={0.5}
          metalness={0.05}
        />
      </mesh>
      {selected ? (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[r * 1.35, r * 1.55, 36]} />
          <meshBasicMaterial color={SAGE_DEEP} side={THREE.DoubleSide} />
        </mesh>
      ) : null}
      <GraphLabel
        position={[0, -r - 1.1, 0]}
        color="#5c6b52"
        fontSize={node.depth === 0 ? 2.8 : 2.3}
      >
        {title}
      </GraphLabel>
    </group>
  );
}

/**
 * Full-page Yaad knowledge graph — hubs on an XZ plane, height by hop/kind.
 */
export function MemoryGraph3D({ entranceKey, className }: MemoryGraph3DProps) {
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);
  const cap = 40;

  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [expanding, setExpanding] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);

  const ambientQuery = useQuery({
    queryKey: ["yaad", "memory-ambient", "full", entranceKey],
    queryFn: () => seedAmbient(),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  useEffect(() => {
    if (ambientQuery.data) {
      setGraph(ambientQuery.data);
    }
  }, [ambientQuery.data]);

  useEffect(() => {
    setSelectedId(null);
    setAnchor(null);
  }, [entranceKey]);

  const laid = useMemo(
    () => layoutMemoryPlane3d(graph, 36, 10),
    [graph],
  );

  const byId = useMemo(() => {
    const map = new Map<string, LaidOutMemoryNode>();
    for (const n of laid) {
      map.set(n.id, n);
    }
    return map;
  }, [laid]);

  const selected = selectedId ? byId.get(selectedId) ?? null : null;

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
        const n = await yaad.getNode(id);
        neighborNodes.push(n);
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
      <GraphSpace key={entranceKey} interactive cameraPosition={[60, 120, 90]}>
        <FitCamera nodes={laid} />
        {graph.edges.map((edge) => {
          const s = byId.get(edge.source);
          const t = byId.get(edge.target);
          if (!s || !t) {
            return null;
          }
          return (
            <Line
              key={edge.id}
              points={[
                [s.x, s.y, s.z],
                [t.x, t.y, t.z],
              ]}
              color={SAGE_LINE}
              lineWidth={1.4}
              transparent
              opacity={0.3 + edge.confidence * 0.4}
            />
          );
        })}
        {laid.map((node) => (
          <MemoryNodeMesh
            key={node.id}
            node={node}
            selected={node.id === selectedId}
            onSelect={(n, screen) => {
              setSelectedId(n.id);
              setAnchor(screen);
            }}
          />
        ))}
      </GraphSpace>

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
