import type { EdgeRecord, NodeKind, NodeRecord, NodeDetail } from "../../api/types";

export type GraphNode = NodeRecord & {
  detail: NodeDetail;
  score?: number;
  hops?: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type: string;
  confidence: number;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

const MEMORY_KINDS = new Set<NodeKind>(["person", "memory", "place", "plan"]);

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

export function truncate(text: string, max = 120): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) {
    return one;
  }
  return `${one.slice(0, max - 1)}…`;
}
