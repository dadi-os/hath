import type { HierarchyPointLink } from "d3-hierarchy";
import type { AgentRecord } from "../../shared/api/types";

/** Hierarchy node for the agent forest SVG. */
export type AgentTreeNode = {
  id: string;
  name: string;
  active: boolean;
  children?: AgentTreeNode[];
};

/** Visual lane for a tree node: running glow, idle, or dormant. */
export type NodeVisual = "running" | "idle" | "dormant";

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

/** Cubic path from parent to child in the tree layout. */
export function linkPath(link: HierarchyPointLink<AgentTreeNode>): string {
  const { source, target } = link;
  const midY = (source.y + target.y) / 2;
  return `M${source.x},${source.y} C${source.x},${midY} ${target.x},${midY} ${target.x},${target.y}`;
}

/**
 * Map agent active + lane occupancy to a tree visual.
 * Prefers live `running` overrides when provided.
 */
export function visualState(
  agent: AgentRecord,
  running: { reasoning: boolean; conversation: boolean } | undefined,
): NodeVisual {
  if (!agent.active) {
    return "dormant";
  }
  const lanes = running ?? agent.running;
  if (lanes.reasoning || lanes.conversation) {
    return "running";
  }
  return "idle";
}

/** Human-readable status for the agent popover / legend. */
export function statusLabel(
  visual: NodeVisual,
  running: { reasoning: boolean; conversation: boolean },
): string {
  if (visual === "dormant") {
    return "Inactive";
  }
  if (visual === "running") {
    if (running.reasoning && running.conversation) {
      return "In flight · reasoning + conversation";
    }
    if (running.reasoning) {
      return "In flight · reasoning";
    }
    if (running.conversation) {
      return "In flight · conversation";
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
