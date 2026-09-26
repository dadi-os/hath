import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useQuery } from "@tanstack/react-query";
import { dimaag, isMeshOnline, nas } from "../../shared/api";
import type { AgentRecord } from "../../shared/api/types";
import { useConnection } from "../../hooks/useConnection";
import { AGENTS_QUERY_KEY } from "../../hooks/useEvents";
import { POLL_MS } from "../../shared/lib/ux/poll";
import {
  ForceGraph,
  syncForceSimulation,
  type ForceGraphNodeLook,
} from "../../shared/components/ForceGraph";
import { GraphSpace } from "../../shared/components/GraphSpace";
import { openAgent } from "../../store/chat";
import { getRunning, seedRunningFromAgents, subscribeRunning } from "../../store/running";
import { AgentPopover } from "./AgentPopover";
import { pickLiveBrowser, pickLiveTerminal } from "./sessions";
import {
  agentGraph,
  agentRadius,
  createAgentSimulation,
  isLiveVisual,
  visualState,
  type NodeVisual,
} from "./tree";

const DETAIL_DELAY_MS = 160;
const DETAIL_CLOSE_MS = 320;

const SAGE = "#8fa382";
const SAGE_DEEP = "#5c6b52";
const SAGE_LINE = "#b9c9ab";
const IDLE = "#a9ba9b";
const BONE = "#fafaf7";

export type AgentGraph3DProps = {
  /** Changes on each arrival at the page; resets the simulation and open details. */
  entranceKey: string;
  /** Page mode: orbit, hover details, click to open chat. Off for the home tile, which only turns slowly. */
  interactive: boolean;
  /** Extra classes on the root element. */
  className?: string;
};

/** Surface for each agent lane; dimmed agents fade behind the focused one. */
function agentLook(visual: NodeVisual, selected: boolean, dimmed: boolean): ForceGraphNodeLook {
  const fade = dimmed ? 0.3 : 1;
  if (visual === "dormant") {
    return { color: SAGE_LINE, opacity: 0.55 * fade, emissiveIntensity: 0, wireframe: true };
  }
  if (visual === "idle") {
    return {
      color: IDLE,
      opacity: fade,
      emissiveIntensity: selected ? 0.4 : 0.1,
      wireframe: false,
    };
  }
  if (visual === "reasoning") {
    return { color: SAGE, opacity: 0.6 * fade, emissiveIntensity: 0.4, wireframe: false };
  }
  return { color: SAGE_DEEP, opacity: fade, emissiveIntensity: 0.5, wireframe: false };
}

/** Breathing translucent shell around an agent that is mid-flight. */
function LiveHalo({ radius }: { radius: number }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    ref.current?.scale.setScalar(radius * 1.7 * (1 + Math.sin(clock.getElapsedTime() * 2.2) * 0.08));
  });
  return (
    <mesh ref={ref} scale={radius * 1.7}>
      <sphereGeometry args={[1, 16, 12]} />
      <meshBasicMaterial color={SAGE} transparent opacity={0.16} depthWrite={false} />
    </mesh>
  );
}

/**
 * Agent forest as a live 3D force graph: top-level threads spread over an inner
 * shell, sub-agents settle on outer shells toward their parent, and a newly spawned
 * sub-agent grows out of its parent. Used full-page and as the home tile.
 */
export function AgentGraph3D({ entranceKey, interactive, className }: AgentGraph3DProps) {
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);
  const runningMap = useSyncExternalStore(subscribeRunning, getRunning, getRunning);
  const rootRef = useRef<HTMLDivElement>(null);

  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: async () => {
      const { agents } = await dimaag.listAgents();
      seedRunningFromAgents(agents);
      return agents;
    },
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const browsersQuery = useQuery({
    queryKey: ["nas", "browsers"],
    queryFn: () => nas.listBrowsers(),
    enabled: connected && interactive,
    refetchInterval: POLL_MS,
  });

  const terminalsQuery = useQuery({
    queryKey: ["nas", "terminals"],
    queryFn: () => nas.listTerminals(),
    enabled: connected && interactive,
    refetchInterval: POLL_MS,
  });

  const agents = agentsQuery.data;
  const agentsById = useMemo(() => {
    const map = new Map<string, AgentRecord>();
    for (const a of agents ?? []) {
      map.set(a.id, a);
    }
    return map;
  }, [agents]);

  const sim = useMemo(() => createAgentSimulation(), [entranceKey]);

  const graph = useMemo(() => {
    const { nodes, edges } = agentGraph(agents ?? []);
    return syncForceSimulation(sim, nodes, edges);
  }, [sim, agents]);

  const pinnedLabels = useMemo(
    () =>
      new Set(
        graph.nodes
          .filter((n) => n.depth === 0 || isLiveVisual(visualState(n, runningMap[n.id])))
          .map((n) => n.id),
      ),
    [graph.nodes, runningMap],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const detailTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearDetailTimer = () => {
    if (detailTimerRef.current !== null) {
      window.clearTimeout(detailTimerRef.current);
      detailTimerRef.current = null;
    }
  };

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const hideDetails = () => {
    clearDetailTimer();
    clearCloseTimer();
    setSelectedId(null);
    setAnchor(null);
  };

  useEffect(() => () => {
    clearDetailTimer();
    clearCloseTimer();
  }, []);

  useEffect(() => {
    hideDetails();
  }, [entranceKey]);

  const scheduleDetails = (agentId: string, at: { x: number; y: number }) => {
    clearCloseTimer();
    if (selectedId === agentId) {
      setAnchor(at);
      return;
    }
    clearDetailTimer();
    detailTimerRef.current = window.setTimeout(() => {
      setSelectedId(agentId);
      setAnchor(at);
    }, DETAIL_DELAY_MS);
  };

  const scheduleClose = () => {
    clearDetailTimer();
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setSelectedId(null);
      setAnchor(null);
    }, DETAIL_CLOSE_MS);
  };

  const movePopoverToAgent = (agentId: string) => {
    clearCloseTimer();
    setSelectedId(agentId);
    if (!rootRef.current) {
      return;
    }
    setAnchor({
      x: rootRef.current.clientWidth / 2,
      y: rootRef.current.clientHeight / 2,
    });
  };

  if (!connected) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">Connect to load agents</p>
      </div>
    );
  }

  if (agentsQuery.isError) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-muted">
          Could not load agents: {agentsQuery.error.message}
        </p>
      </div>
    );
  }

  if (!agents) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-muted">Loading agents…</p>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-muted">No agents yet</p>
      </div>
    );
  }

  const detailAgent = selectedId ? agentsById.get(selectedId) : undefined;
  const detailBrowserId =
    detailAgent && browsersQuery.isSuccess
      ? pickLiveBrowser(detailAgent.sessions.browsers, browsersQuery.data)
      : null;
  const detailTerminal =
    detailAgent && terminalsQuery.isSuccess
      ? pickLiveTerminal(detailAgent.sessions.terminals, terminalsQuery.data)
      : null;

  return (
    <div ref={rootRef} className={`relative h-full min-h-0 w-full ${className ?? ""}`}>
      <GraphSpace
        key={entranceKey}
        interactive={interactive}
        cameraPosition={[0, 50, 200]}
      >
        <ForceGraph
          sim={sim}
          graph={graph}
          selectedId={selectedId}
          radius={(n) => agentRadius(n.depth, !n.active)}
          look={(n, { selected, dimmed }) =>
            agentLook(visualState(n, runningMap[n.id]), selected, dimmed)
          }
          labelText={(n) => (n.name.length > 30 ? `${n.name.slice(0, 29)}…` : n.name)}
          pinnedLabels={pinnedLabels}
          decorate={(n, r) => {
            const visual = visualState(n, runningMap[n.id]);
            return (
              <>
                {isLiveVisual(visual) ? <LiveHalo radius={r} /> : null}
                {visual === "both" ? (
                  <mesh scale={r * 0.42}>
                    <sphereGeometry args={[1, 16, 12]} />
                    <meshStandardMaterial color={BONE} roughness={0.55} />
                  </mesh>
                ) : null}
              </>
            );
          }}
          onNodeHover={interactive ? (n, at) => scheduleDetails(n.id, at) : undefined}
          onNodeLeave={interactive ? scheduleClose : undefined}
          onNodeClick={
            interactive
              ? (n) => {
                  hideDetails();
                  openAgent(n.id);
                }
              : undefined
          }
        />
      </GraphSpace>

      {interactive ? (
        <AgentPopover
          open={selectedId !== null && anchor !== null}
          agentId={selectedId}
          agentsById={agentsById}
          runningMap={runningMap}
          anchor={anchor}
          containerRef={rootRef as RefObject<HTMLElement | null>}
          browserId={detailBrowserId}
          terminal={detailTerminal}
          onHoverStart={clearCloseTimer}
          onHoverEnd={scheduleClose}
          onClose={hideDetails}
          onSelectParent={movePopoverToAgent}
        />
      ) : null}
    </div>
  );
}
