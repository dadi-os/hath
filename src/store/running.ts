import type { AgentRecord, Lane } from "../shared/api/types";

export type RunningMap = Record<string, { reasoning: boolean; conversation: boolean }>;

type Listener = (running: RunningMap) => void;

let running: RunningMap = {};
let dadiBusy = false;
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
  if (runningMapsEqual(running, next)) {
    return;
  }
  running = next;
  emit();
}

function runningMapsEqual(a: RunningMap, b: RunningMap): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const id of aKeys) {
    const left = a[id];
    const right = b[id];
    if (
      !right ||
      left.reasoning !== right.reasoning ||
      left.conversation !== right.conversation
    ) {
      return false;
    }
  }
  return true;
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

/** True while POST /dadi is classifying. */
export function isDadiBusy(): boolean {
  return dadiBusy;
}

/** Set from SSE `dadi_started` / `dadi_finished` / `dadi_failed`. */
export function setDadiBusy(next: boolean): void {
  if (dadiBusy === next) {
    return;
  }
  dadiBusy = next;
  running = { ...running };
  emit();
}
