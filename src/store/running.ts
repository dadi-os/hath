import type { AgentRecord, Lane } from "../shared/api/types";

export type RunningMap = Record<string, { reasoning: boolean; conversation: boolean }>;

type Listener = (running: RunningMap) => void;

let running: RunningMap = {};
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    listener(running);
  }
}

export function getRunning(): RunningMap {
  return running;
}

export function subscribeRunning(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Seed from GET /agents (or reconnect refetch). */
export function seedRunningFromAgents(agents: AgentRecord[]): void {
  const next: RunningMap = {};
  for (const agent of agents) {
    next[agent.id] = { ...agent.running };
  }
  running = next;
  emit();
}

export function setLaneRunning(
  agentId: string,
  lane: Lane,
  isRunning: boolean,
): void {
  const current = running[agentId] ?? { reasoning: false, conversation: false };
  running = {
    ...running,
    [agentId]: { ...current, [lane]: isRunning },
  };
  emit();
}
