import type { ForceLink, Simulation } from "d3-force-3d";

/** Id-keyed edge a force graph draws between two records. */
export type ForceEdge = {
  id: string;
  source: string;
  target: string;
};

/** Record placed in 3D space; d3 mutates x/y/z and velocities in place. */
export type ForceNode<R> = R & {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  /** Incident edge count; features size nodes and pick labels by it. */
  degree: number;
};

/** Link as handed to d3; it swaps the id endpoints for node objects. */
export type ForceLinkDatum<R, E extends ForceEdge> = Omit<E, "source" | "target"> & {
  source: ForceNode<R> | string;
  target: ForceNode<R> | string;
};

/** Link after a sync, endpoints resolved to live nodes. */
export type ForceLinkResolved<R, E extends ForceEdge> = Omit<E, "source" | "target"> & {
  source: ForceNode<R>;
  target: ForceNode<R>;
};

/**
 * A feature's 3D force simulation. Features choose the forces but must register
 * their link force under the name `"link"` with an id accessor of `node.id`.
 */
export type ForceGraphSimulation<R, E extends ForceEdge> = Simulation<
  ForceNode<R>,
  ForceLinkDatum<R, E>
>;

/** Live simulation objects after a sync. */
export type SyncedForceGraph<R, E extends ForceEdge> = {
  nodes: ForceNode<R>[];
  links: ForceLinkResolved<R, E>[];
};

/** Distance from the anchor neighbor at which a newly arrived node spawns. */
const SPAWN_RADIUS = 6;

/** Random point on a sphere of `radius` around `origin`. */
function spawnNear(
  origin: { x: number; y: number; z: number },
  radius: number,
): { x: number; y: number; z: number } {
  const u = Math.random() * 2 - 1;
  const theta = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return {
    x: origin.x + radius * s * Math.cos(theta),
    y: origin.y + radius * s * Math.sin(theta),
    z: origin.z + radius * u,
  };
}

/**
 * Reconcile `records` and `edges` into a running simulation and return its live objects.
 *
 * Existing nodes keep their position and velocity. A new node spawns beside an
 * already-placed neighbor so the graph visibly grows outward from where it attaches;
 * a new node with no placed neighbor is left for d3-force-3d to seed on its 3D
 * phyllotaxis spiral. Any membership change reheats the simulation. `edges` must
 * only reference ids present in `records`.
 */
export function syncForceSimulation<R extends { id: string }, E extends ForceEdge>(
  sim: ForceGraphSimulation<R, E>,
  records: R[],
  edges: E[],
): SyncedForceGraph<R, E> {
  const previous = new Map(sim.nodes().map((n) => [n.id, n]));
  const degree = new Map<string, number>();
  const neighbors = new Map<string, string[]>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    neighbors.set(e.source, [...(neighbors.get(e.source) ?? []), e.target]);
    neighbors.set(e.target, [...(neighbors.get(e.target) ?? []), e.source]);
  }

  const placed = new Map<string, ForceNode<R>>();
  const pending = new Map<string, ForceNode<R>>();
  for (const record of records) {
    const old = previous.get(record.id);
    const d = degree.get(record.id) ?? 0;
    if (old) {
      placed.set(record.id, Object.assign(old, record, { degree: d }));
    } else {
      pending.set(record.id, { ...record, degree: d } as ForceNode<R>);
    }
  }

  let progress = previous.size > 0;
  while (progress && pending.size > 0) {
    progress = false;
    for (const node of [...pending.values()]) {
      const anchor = (neighbors.get(node.id) ?? [])
        .map((id) => placed.get(id))
        .find((n) => n !== undefined);
      if (anchor) {
        Object.assign(node, spawnNear(anchor, SPAWN_RADIUS));
        placed.set(node.id, node);
        pending.delete(node.id);
        progress = true;
      }
    }
  }

  const nodes = records.map((r) => placed.get(r.id) ?? pending.get(r.id)!);
  const changed = nodes.length !== previous.size || nodes.some((n) => !previous.has(n.id));
  sim.nodes(nodes);
  const links = edges.map((e) => ({ ...e }) as ForceLinkDatum<R, E>);
  (sim.force("link") as ForceLink<ForceNode<R>, ForceLinkDatum<R, E>>).links(links);
  if (changed) {
    sim.alpha(previous.size === 0 ? 1 : Math.max(sim.alpha(), 0.5));
  }
  return { nodes, links: links as ForceLinkResolved<R, E>[] };
}
