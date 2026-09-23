import type { AgentRecord } from "../../shared/api/types";

/** Hierarchy node for the agent forest SVG. */
export type AgentTreeNode = {
  id: string;
  name: string;
  active: boolean;
  children?: AgentTreeNode[];
};

/** Visual lane for a tree node — fill weight encodes reasoning vs conversation. */
export type NodeVisual =
  | "dormant"
  | "idle"
  | "reasoning"
  | "conversation"
  | "both";

/**
 * Build a forest from parent_agent_id. Every null or dangling parent is a root.
 * There is no Dadi node — top-level threads are the roots.
 */
export function buildTree(agents: AgentRecord[]): AgentTreeNode[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const childrenOf = new Map<string, AgentRecord[]>();
  const roots: AgentRecord[] = [];

  for (const agent of agents) {
    const parentId = agent.parent_agent_id;
    if (parentId === null || !byId.has(parentId)) {
      roots.push(agent);
      continue;
    }
    const list = childrenOf.get(parentId) ?? [];
    list.push(agent);
    childrenOf.set(parentId, list);
  }

  function toNode(agent: AgentRecord): AgentTreeNode {
    const kids = childrenOf.get(agent.id) ?? [];
    return {
      id: agent.id,
      name: agent.name,
      active: agent.active,
      children: kids.length > 0 ? kids.map(toNode) : undefined,
    };
  }

  return roots.map(toNode);
}

/** Positioned agent in the forest layout (x = breadth, z = depth, y = height). */
export type LaidOutNode = {
  data: AgentTreeNode;
  x: number;
  y: number;
  z: number;
  depth: number;
};

/** Parent → child edge in the forest layout. */
export type LaidOutLink = {
  source: LaidOutNode;
  target: LaidOutNode;
};

/** Count leaves under a node (1 for a leaf). Drives horizontal spacing. */
function leafCount(node: AgentTreeNode): number {
  const kids = node.children ?? [];
  if (kids.length === 0) {
    return 1;
  }
  return kids.reduce((sum, child) => sum + leafCount(child), 0);
}

/**
 * Wide hierarchical forest in 3D.
 * Roots pack along X by subtree leaf width; depth advances along Z;
 * Y stays near zero with a slight sibling fan for separation.
 */
export function layoutForest3d(
  forest: AgentTreeNode[],
  siblingGap: number,
  depthStep: number,
): { nodes: LaidOutNode[]; links: LaidOutLink[] } {
  const nodes: LaidOutNode[] = [];
  const links: LaidOutLink[] = [];
  if (forest.length === 0) {
    return { nodes, links };
  }

  const rootGap = siblingGap * 1.35;
  let cursor = 0;

  const place = (
    data: AgentTreeNode,
    left: number,
    depth: number,
    parent: LaidOutNode | null,
    siblingIndex: number,
    siblingCount: number,
  ): { node: LaidOutNode; right: number } => {
    const kids = data.children ?? [];
    let node: LaidOutNode;
    let right: number;

    if (kids.length === 0) {
      const x = left + siblingGap / 2;
      const fan =
        siblingCount <= 1
          ? 0
          : ((siblingIndex - (siblingCount - 1) / 2) / siblingCount) * siblingGap * 0.22;
      node = {
        data,
        x,
        y: fan,
        z: depth * depthStep,
        depth,
      };
      right = left + siblingGap;
    } else {
      const width = leafCount(data) * siblingGap;
      let childLeft = left;
      const childNodes: LaidOutNode[] = [];
      kids.forEach((child, index) => {
        const placed = place(child, childLeft, depth + 1, null, index, kids.length);
        childNodes.push(placed.node);
        childLeft = placed.right;
      });
      const midX =
        (childNodes[0].x + childNodes[childNodes.length - 1].x) / 2;
      node = {
        data,
        x: midX,
        y: 0,
        z: depth * depthStep,
        depth,
      };
      for (const child of childNodes) {
        links.push({ source: node, target: child });
      }
      right = left + width;
    }

    nodes.push(node);
    if (parent) {
      links.push({ source: parent, target: node });
    }
    return { node, right };
  };

  forest.forEach((root, index) => {
    const placed = place(root, cursor, 0, null, index, forest.length);
    cursor = placed.right + rootGap;
  });

  // Center the forest on the origin so the camera frames it cleanly.
  if (nodes.length > 0) {
    let minX = Infinity;
    let maxX = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
    }
    const mid = (minX + maxX) / 2;
    for (const n of nodes) {
      n.x -= mid;
    }
  }

  return { nodes, links };
}

/**
 * Project the forest onto the XZ plane for SVG preview (svgY ← z).
 */
export function projectForest2d(
  laid: { nodes: LaidOutNode[]; links: LaidOutLink[] },
): { nodes: LaidOutNode[]; links: LaidOutLink[] } {
  const byId = new Map<string, LaidOutNode>();
  const nodes = laid.nodes.map((n) => {
    const projected: LaidOutNode = {
      ...n,
      y: n.z,
      z: 0,
    };
    byId.set(n.data.id, projected);
    return projected;
  });
  const links = laid.links.map((link) => ({
    source: byId.get(link.source.data.id)!,
    target: byId.get(link.target.data.id)!,
  }));
  return { nodes, links };
}

/** Straight segment between two laid-out nodes (uses x/y of the active plane). */
export function linkPath(link: LaidOutLink): string {
  const { source, target } = link;
  return `M${source.x},${source.y} L${target.x},${target.y}`;
}

export type LabelPlacement = {
  /** Offset from the node origin. */
  x: number;
  y: number;
  textAnchor: "start" | "middle" | "end";
  dominantBaseline: "auto" | "middle" | "hanging";
};

/** Smallest absolute difference between two angles, in radians. */
function angleGap(a: number, b: number): number {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

/**
 * Direction with the most room away from this node's links.
 * Isolated nodes fall back to the outward ray.
 */
function clearestAngle(node: LaidOutNode, dirs: number[]): number {
  if (dirs.length === 0) {
    return Math.atan2(node.y, node.x);
  }
  let best = 0;
  let bestScore = -1;
  const steps = 32;
  for (let i = 0; i < steps; i++) {
    const angle = -Math.PI + (i * Math.PI * 2) / steps;
    let score = Infinity;
    for (const dir of dirs) {
      score = Math.min(score, angleGap(angle, dir));
    }
    if (score > bestScore) {
      best = angle;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Hang the name off the links that touch this node.
 * `gap` is the distance from the node origin to the text anchor, in SVG units.
 */
export function labelPlacement(
  node: LaidOutNode,
  links: LaidOutLink[],
  gap: number,
): LabelPlacement {
  const dirs: number[] = [];
  for (const link of links) {
    if (link.source === node) {
      dirs.push(Math.atan2(link.target.y - node.y, link.target.x - node.x));
    } else if (link.target === node) {
      dirs.push(Math.atan2(link.source.y - node.y, link.source.x - node.x));
    }
  }
  const angle = clearestAngle(node, dirs);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const textAnchor: LabelPlacement["textAnchor"] =
    Math.abs(cos) < 0.45 ? "middle" : cos > 0 ? "start" : "end";
  const dominantBaseline: LabelPlacement["dominantBaseline"] =
    textAnchor !== "middle" ? "middle" : sin > 0 ? "hanging" : "auto";
  return {
    x: cos * gap,
    y: sin * gap,
    textAnchor,
    dominantBaseline,
  };
}

/**
 * Map agent active + lane occupancy to a tree visual.
 * Prefers live lane occupancy overrides when provided.
 * Fill language: soft = reasoning, solid = conversation, solid+core = both.
 */
export function visualState(
  agent: AgentRecord,
  running: { reasoning: boolean; conversation: boolean } | undefined,
): NodeVisual {
  if (!agent.active) {
    return "dormant";
  }
  const lanes = running ?? agent.running;
  if (lanes.reasoning && lanes.conversation) {
    return "both";
  }
  if (lanes.reasoning) {
    return "reasoning";
  }
  if (lanes.conversation) {
    return "conversation";
  }
  return "idle";
}

/** True when the node is mid-flight on either lane. */
export function isLiveVisual(visual: NodeVisual): boolean {
  return (
    visual === "reasoning" ||
    visual === "conversation" ||
    visual === "both"
  );
}

/** Human-readable status for the agent popover / legend. */
export function statusLabel(
  visual: NodeVisual,
  running: { reasoning: boolean; conversation: boolean },
): string {
  if (visual === "dormant") {
    return "Inactive";
  }
  if (isLiveVisual(visual)) {
    if (running.reasoning && running.conversation) {
      return "In flight · thinking + working";
    }
    if (running.reasoning) {
      return "In flight · working";
    }
    if (running.conversation) {
      return "In flight · thinking";
    }
    return "In flight";
  }
  return "Idle";
}

/** Relative time label (e.g. "3 minutes ago"). */
export function formatRelative(iso: string, now = Date.now()): string {
  const diffSec = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const abs = Math.abs(diffSec);
  if (abs < 60) {
    return rtf.format(diffSec, "second");
  }
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) {
    return rtf.format(diffMin, "minute");
  }
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) {
    return rtf.format(diffHour, "hour");
  }
  return rtf.format(Math.round(diffHour / 24), "day");
}

/** Absolute local date+time for tooltips. */
export function formatAbsolute(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}
