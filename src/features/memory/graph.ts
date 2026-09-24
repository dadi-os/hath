import type { EdgeRecord, NodeKind, NodeRecord, NodeDetail } from "../../shared/api/types";

/** Yaad node with optional recall score/hops for the memory graph. */
export type GraphNode = NodeRecord & {
  detail: NodeDetail;
  score?: number;
  hops?: number;
};

/** Undirected-render edge for the force layout (source/target = node ids). */
export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type: string;
  confidence: number;
};

/** Nodes + edges held by the memory graph view. */
export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

const MEMORY_KINDS = new Set<NodeKind>(["person", "memory", "place", "plan"]);

/** Circle radius by kind; `preview` shrinks for widget tiles. */
export function nodeRadius(kind: NodeKind, preview: boolean): number {
  const scale = preview ? 0.85 : 1;
  if (kind === "person") {
    return 8 * scale;
  }
  if (kind === "place") {
    return 6.5 * scale;
  }
  if (kind === "plan") {
    return 5 * scale;
  }
  return 5.5 * scale;
}

/**
 * Merge incoming recall/query nodes and edges into the current graph.
 * Caps node count by access_count then score; drops edges to pruned nodes.
 */
export function mergeGraph(
  current: GraphData,
  incoming: {
    nodes: GraphNode[];
    edges: EdgeRecord[];
  },
  cap: number,
): GraphData {
  const byId = new Map(current.nodes.map((n) => [n.id, n]));
  for (const n of incoming.nodes) {
    if (!MEMORY_KINDS.has(n.kind)) {
      continue;
    }
    const existing = byId.get(n.id);
    byId.set(n.id, existing ? { ...existing, ...n } : n);
  }

  let nodes = [...byId.values()];
  if (nodes.length > cap) {
    nodes = nodes
      .slice()
      .sort(
        (a, b) =>
          (b.access_count ?? 0) - (a.access_count ?? 0) ||
          (b.score ?? 0) - (a.score ?? 0),
      )
      .slice(0, cap);
  }
  const keep = new Set(nodes.map((n) => n.id));

  const edgeById = new Map(current.edges.map((e) => [e.id, e]));
  for (const e of incoming.edges) {
    if (!keep.has(e.src_id) || !keep.has(e.dst_id)) {
      continue;
    }
    edgeById.set(e.id, {
      id: e.id,
      source: e.src_id,
      target: e.dst_id,
      type: e.type,
      confidence: e.confidence,
    });
  }

  const edges = [...edgeById.values()].filter(
    (e) => keep.has(e.source) && keep.has(e.target),
  );

  return { nodes, edges };
}

/** Collapse whitespace and ellipsize for graph labels. */
export function truncate(text: string, max = 120): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) {
    return one;
  }
  return `${one.slice(0, max - 1)}…`;
}

/** Positioned Yaad node for the spatial memory scene. */
export type LaidOutMemoryNode = GraphNode & {
  x: number;
  y: number;
  z: number;
  depth: number;
};

/** Base height by kind so the ground plane reads as neighborhoods. */
function kindLift(kind: NodeKind): number {
  if (kind === "person") {
    return 0;
  }
  if (kind === "place") {
    return 1.5;
  }
  if (kind === "plan") {
    return 12;
  }
  return 20;
}

/**
 * Spatial Yaad layout: hubs on an XZ ground plane, neighbors radiate in rings,
 * Y carries hop depth + kind so the graph fills real volume when expanded.
 */
export function layoutMemoryPlane3d(
  data: GraphData,
  ringStep: number,
  hopLift: number,
): LaidOutMemoryNode[] {
  if (data.nodes.length === 0) {
    return [];
  }

  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, string[]>();
  for (const n of data.nodes) {
    adj.set(n.id, []);
  }
  for (const e of data.edges) {
    adj.get(e.source)?.push(e.target);
    adj.get(e.target)?.push(e.source);
  }

  const hubs = data.nodes.filter((n) => n.kind === "person" || n.kind === "place");
  const seedRoots = hubs.length > 0 ? hubs : [data.nodes[0]];

  const depthOf = new Map<string, number>();
  const parentOf = new Map<string, string | null>();
  const queue: string[] = [];

  for (const r of seedRoots) {
    if (!depthOf.has(r.id)) {
      depthOf.set(r.id, 0);
      parentOf.set(r.id, null);
      queue.push(r.id);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const depth = depthOf.get(id)!;
    for (const nb of adj.get(id) ?? []) {
      if (depthOf.has(nb)) {
        continue;
      }
      depthOf.set(nb, depth + 1);
      parentOf.set(nb, id);
      queue.push(nb);
    }
  }

  for (const n of data.nodes) {
    if (!depthOf.has(n.id)) {
      depthOf.set(n.id, 0);
      parentOf.set(n.id, null);
    }
  }

  const childrenOf = new Map<string | null, string[]>();
  for (const n of data.nodes) {
    const p = parentOf.get(n.id) ?? null;
    const list = childrenOf.get(p) ?? [];
    list.push(n.id);
    childrenOf.set(p, list);
  }

  const pos = new Map<string, { x: number; y: number; z: number }>();
  const rootIds = childrenOf.get(null) ?? [];
  const hubCount = Math.max(rootIds.length, 1);
  const hubRadius = Math.max(ringStep * 2.4, Math.sqrt(hubCount) * ringStep * 1.35);

  rootIds.forEach((id, i) => {
    const node = byId.get(id);
    if (!node) {
      return;
    }
    const angle =
      hubCount === 1 ? -Math.PI / 2 : (i / hubCount) * Math.PI * 2 - Math.PI / 2;
    const spiral = Math.floor(i / Math.max(hubCount, 1)) * ringStep * 0.4;
    const r = hubRadius + spiral;
    pos.set(id, {
      x: Math.cos(angle) * r,
      y: kindLift(node.kind),
      z: Math.sin(angle) * r,
    });
  });

  const placeChildren = (parentId: string) => {
    const parent = pos.get(parentId);
    const kids = childrenOf.get(parentId) ?? [];
    if (!parent || kids.length === 0) {
      return;
    }
    const parentDepth = depthOf.get(parentId) ?? 0;
    const ring = ringStep * (1.1 + parentDepth * 0.35);
    const spread =
      kids.length === 1 ? 0 : Math.min(Math.PI * 1.4, kids.length * 0.55);
    const baseAngle = Math.atan2(parent.z, parent.x);

    kids.forEach((kidId, index) => {
      if (pos.has(kidId)) {
        return;
      }
      const child = byId.get(kidId);
      if (!child) {
        return;
      }
      const depth = depthOf.get(kidId) ?? parentDepth + 1;
      const offset =
        kids.length === 1
          ? 0
          : (index - (kids.length - 1) / 2) * (spread / Math.max(kids.length - 1, 1));
      const angle = baseAngle + Math.PI + offset;
      pos.set(kidId, {
        x: parent.x + Math.cos(angle) * ring,
        y: kindLift(child.kind) + depth * hopLift,
        z: parent.z + Math.sin(angle) * ring,
      });
      placeChildren(kidId);
    });
  };

  for (const id of rootIds) {
    placeChildren(id);
  }

  // Unreached nodes: deterministic ring near origin (no random scatter).
  let orphanIndex = 0;
  for (const n of data.nodes) {
    if (!pos.has(n.id)) {
      const a = orphanIndex * 2.399;
      const r = ringStep * (0.6 + (orphanIndex % 5) * 0.15);
      pos.set(n.id, {
        x: Math.cos(a) * r,
        y: kindLift(n.kind),
        z: Math.sin(a) * r,
      });
      orphanIndex += 1;
    }
  }

  const laid: LaidOutMemoryNode[] = data.nodes.map((n) => {
    const p = pos.get(n.id)!;
    return {
      ...n,
      x: p.x,
      y: p.y,
      z: p.z,
      depth: depthOf.get(n.id) ?? 0,
    };
  });

  if (laid.length > 0) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const n of laid) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minZ = Math.min(minZ, n.z);
      maxZ = Math.max(maxZ, n.z);
    }
    const midX = (minX + maxX) / 2;
    const midZ = (minZ + maxZ) / 2;
    for (const n of laid) {
      n.x -= midX;
      n.z -= midZ;
    }
  }

  return laid;
}
