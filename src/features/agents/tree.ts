import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
} from "d3-force-3d";
import type { AgentRecord } from "../../shared/api/types";
import type {
  ForceGraphSimulation,
  ForceLinkDatum,
  ForceNode,
} from "../../shared/components/ForceGraph";

/** Agent with its depth below its root (0 = top-level thread). */
export type AgentGraphNode = AgentRecord & { depth: number };

/** Parent → child link between agent ids. */
export type AgentEdge = { id: string; source: string; target: string };

/** Agent living in the agents force simulation. */
export type AgentNode = ForceNode<AgentGraphNode>;

/** The agents view's 3D force simulation. */
export type AgentSimulation = ForceGraphSimulation<AgentGraphNode, AgentEdge>;

/** Visual lane for an agent node — fill weight encodes reasoning vs conversation. */
export type NodeVisual =
  | "dormant"
  | "idle"
  | "reasoning"
  | "conversation"
  | "both";

/** Radius of the shell top-level agents sit on. */
const ROOT_SHELL = 42;
/** Extra radius per level of depth; also the parent → child spring length. */
const SHELL_STEP = 34;

/**
 * Agents with depth plus parent → child edges. A null or dangling parent makes the
 * agent a root; there is no Dadi node — top-level threads are the roots.
 * @throws When parent links form a cycle.
 */
export function agentGraph(agents: AgentRecord[]): {
  nodes: AgentGraphNode[];
  edges: AgentEdge[];
} {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const depthOf = new Map<string, number>();

  const depth = (agent: AgentRecord, seen: Set<string>): number => {
    const known = depthOf.get(agent.id);
    if (known !== undefined) {
      return known;
    }
    if (seen.has(agent.id)) {
      throw new Error(`agent parent cycle through ${agent.id}`);
    }
    seen.add(agent.id);
    const parent = agent.parent_agent_id === null ? undefined : byId.get(agent.parent_agent_id);
    const d = parent ? depth(parent, seen) + 1 : 0;
    depthOf.set(agent.id, d);
    return d;
  };

  const nodes = agents.map((a) => ({ ...a, depth: depth(a, new Set()) }));
  const edges = agents
    .filter((a) => a.parent_agent_id !== null && byId.has(a.parent_agent_id))
    .map((a) => ({ id: `${a.parent_agent_id}>${a.id}`, source: a.parent_agent_id!, target: a.id }));
  return { nodes, edges };
}

/** Distance from the origin of the shell an agent at `depth` settles on. */
export function shellRadius(depth: number): number {
  return ROOT_SHELL + depth * SHELL_STEP;
}

/** Sphere radius: roots read larger, dormant agents recede. */
export function agentRadius(depth: number, dormant: boolean): number {
  const base = depth === 0 ? 4.2 : 3.1;
  return dormant ? base * 0.75 : base;
}

/**
 * Stopped 3D simulation that grows the agent forest outward like a dandelion:
 * a radial force holds each agent on the shell for its depth, springs pull children
 * toward their parent's direction, and repulsion spreads siblings over the shell.
 * Fed by `syncForceSimulation` and ticked by `ForceGraph`.
 */
export function createAgentSimulation(): AgentSimulation {
  return forceSimulation<AgentNode, ForceLinkDatum<AgentGraphNode, AgentEdge>>([], 3)
    .stop()
    .force("charge", forceManyBody<AgentNode>().strength(-90).distanceMax(260))
    .force(
      "link",
      forceLink<AgentNode, ForceLinkDatum<AgentGraphNode, AgentEdge>>([])
        .id((n) => n.id)
        .distance(SHELL_STEP)
        .strength(0.7),
    )
    .force("radial", forceRadial<AgentNode>((n) => shellRadius(n.depth)).strength(0.9))
    .force("collide", forceCollide<AgentNode>((n) => agentRadius(n.depth, !n.active) + 2));
}

/**
 * Map agent active + lane occupancy to a node visual.
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
