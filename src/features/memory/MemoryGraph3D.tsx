import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useThree } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { useQuery } from "@tanstack/react-query";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force-3d";
import { isMeshOnline, yaad } from "../../shared/api";
import type { EdgeRecord, NodeKind } from "../../shared/api/types";
import { useConnection } from "../../hooks/useConnection";
import { GraphSpace, CameraDistanceReporter } from "../../shared/components/GraphSpace";
import { Popover } from "../../shared/components/Popover";
import { POLL_MS } from "../../shared/lib/ux/poll";
import {
  mergeGraph,
  nodeRadius,
  truncate,
  type GraphData,
  type GraphEdge,
  type GraphNode,
} from "./graph";

const SAGE = "#8fa382";
const SAGE_DEEP = "#5c6b52";
const SAGE_LINE = "#b9c9ab";
const BONE = "#fafaf7";
const BONE_RAISED = "#f7f9f4";
const SAGE_ACTIVE = "rgb(143, 163, 130)";

type SimNode = GraphNode & SimulationNodeDatum;
type SimLink = GraphEdge & SimulationLinkDatum<SimNode>;

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
  return SAGE_ACTIVE;
}

/** Kind → emissive / stroke accent. */
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
 * Frame the camera on the simulated node cloud.
 */
function FitCamera({ nodes }: { nodes: SimNode[] }) {
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
      box.expandByPoint(new THREE.Vector3(n.x ?? 0, n.y ?? 0, n.z ?? 0));
    }
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const span = Math.max(size.x, size.y, size.z, 40);
    const dist = span * 1.5;

    camera.position.set(center.x + dist * 0.35, center.y + dist * 0.55, center.z + dist * 0.95);
    camera.near = 0.5;
    camera.far = Math.max(4000, dist * 8);
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
  node: SimNode;
  selected: boolean;
  showLabel: boolean;
  onSelect: (node: SimNode, screen: { x: number; y: number }) => void;
};

/**
 * Single Yaad node mesh in the force graph.
 */
function MemoryNodeMesh({
  node,
  selected,
  showLabel,
  onSelect,
}: MemoryNodeMeshProps) {
  const { gl } = useThree();
  const r = nodeRadius(node.kind, false) * 0.85;

  return (
    <group position={[node.x ?? 0, node.y ?? 0, node.z ?? 0]}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          const rect = gl.domElement.getBoundingClientRect();
          onSelect(node, {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        }}
      >
        <sphereGeometry args={[r, 20, 20]} />
        <meshStandardMaterial
          color={kindColor(node.kind)}
          emissive={selected ? kindAccent(node.kind) : "#000000"}
          emissiveIntensity={selected ? 0.35 : 0}
          roughness={0.55}
          metalness={0.04}
        />
      </mesh>
      {selected ? (
        <mesh>
          <ringGeometry args={[r * 1.3, r * 1.5, 28]} />
          <meshBasicMaterial color={SAGE_DEEP} side={THREE.DoubleSide} />
        </mesh>
      ) : null}
      {showLabel ? (
        <Html
          distanceFactor={70}
          style={{
            pointerEvents: "none",
            userSelect: "none",
            color: "#6e7568",
            fontSize: "10px",
            fontWeight: 500,
            letterSpacing: "0.02em",
            whiteSpace: "nowrap",
            transform: "translate(-50%, 10px)",
          }}
          center
        >
          {node.title.length > 18 ? `${node.title.slice(0, 17)}…` : node.title}
        </Html>
      ) : null}
    </group>
  );
}

/**
 * Edge line between simulated endpoints.
 */
function MemoryLinkLine({ link }: { link: SimLink }) {
  const s = link.source as SimNode;
  const t = link.target as SimNode;
  return (
    <Line
      points={[
        [s.x ?? 0, s.y ?? 0, s.z ?? 0],
        [t.x ?? 0, t.y ?? 0, t.z ?? 0],
      ]}
      color={SAGE_LINE}
      lineWidth={1}
      transparent
      opacity={0.25 + link.confidence * 0.45}
    />
  );
}

/**
 * Full-page Yaad knowledge graph in 3D force layout.
 */
export function MemoryGraph3D({ entranceKey, className }: MemoryGraph3DProps) {
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);
  const cap = 40;

  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });
  const [simNodes, setSimNodes] = useState<SimNode[]>([]);
  const [simLinks, setSimLinks] = useState<SimLink[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [labelsFar, setLabelsFar] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode, SimLink>> | null>(
    null,
  );
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);

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

  useEffect(() => {
    simRef.current?.stop();
    if (graph.nodes.length === 0) {
      setSimNodes([]);
      setSimLinks([]);
      nodesRef.current = [];
      linksRef.current = [];
      return;
    }

    const prevById = new Map(nodesRef.current.map((n) => [n.id, n]));
    const nodes: SimNode[] = graph.nodes.map((n) => {
      const prev = prevById.get(n.id);
      return {
        ...n,
        x: prev?.x,
        y: prev?.y,
        z: prev?.z,
        vx: prev?.vx,
        vy: prev?.vy,
        vz: prev?.vz,
      };
    });
    const links: SimLink[] = graph.edges.map((e) => ({ ...e }));

    const sim = forceSimulation<SimNode, SimLink>(nodes, 3)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(64)
          .strength(0.45),
      )
      .force("charge", forceManyBody().strength(-140))
      .force("center", forceCenter(0, 0, 0))
      .force(
        "collide",
        forceCollide<SimNode>()
          .radius((d) => nodeRadius(d.kind, false) + 4)
          .strength(0.8),
      )
      .alpha(0.9)
      .alphaDecay(0.028);

    simRef.current = sim;
    nodesRef.current = nodes;
    linksRef.current = links;

    const publish = () => {
      setSimNodes(nodes.map((n) => ({ ...n })));
      setSimLinks(links.map((l) => ({ ...l })));
      nodesRef.current = nodes;
      linksRef.current = links;
    };
    sim.on("tick", publish);
    for (let i = 0; i < 80; i++) {
      sim.tick();
    }
    publish();

    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [graph]);

  const selected = useMemo(
    () => simNodes.find((n) => n.id === selectedId) ?? null,
    [simNodes, selectedId],
  );

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
      <GraphSpace key={entranceKey} interactive cameraPosition={[40, 90, 180]}>
        <FitCamera nodes={simNodes} />
        <CameraDistanceReporter onFar={setLabelsFar} farThreshold={280} />
        {simLinks.map((link) => (
          <MemoryLinkLine key={link.id} link={link} />
        ))}
        {simNodes.map((node) => (
          <MemoryNodeMesh
            key={node.id}
            node={node}
            selected={node.id === selectedId}
            showLabel={!labelsFar || node.id === selectedId}
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
