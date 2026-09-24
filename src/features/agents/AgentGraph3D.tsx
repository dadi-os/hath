import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import { useQuery } from "@tanstack/react-query";
import { dimaag, isMeshOnline, nas } from "../../shared/api";
import type { AgentRecord } from "../../shared/api/types";
import { useConnection } from "../../hooks/useConnection";
import { AGENTS_QUERY_KEY } from "../../hooks/useEvents";
import { POLL_MS } from "../../shared/lib/ux/poll";
import { GraphLabel } from "../../shared/components/GraphLabel";
import { GraphSpace } from "../../shared/components/GraphSpace";
import { openAgent } from "../../store/chat";
import { getRunning, seedRunningFromAgents, subscribeRunning } from "../../store/running";
import { AgentPopover } from "./AgentPopover";
import { pickLiveBrowser, pickLiveTerminal } from "./sessions";
import {
  buildTree,
  isLiveVisual,
  layoutForest3d,
  visualState,
  type LaidOutNode,
  type NodeVisual,
} from "./tree";

const DETAIL_DELAY_MS = 160;
const DETAIL_CLOSE_MS = 320;

const SAGE = "#8fa382";
const SAGE_DEEP = "#5c6b52";
const SAGE_LINE = "#b9c9ab";
const BONE = "#fafaf7";
const IDLE_FILL = "#dce5d4";

export type AgentGraph3DProps = {
  entranceKey: string;
  className?: string;
};

/** Mesh color / opacity for each agent visual lane. */
function visualMaterial(visual: NodeVisual, selected: boolean): {
  color: string;
  opacity: number;
  emissive: string;
  emissiveIntensity: number;
} {
  if (visual === "dormant") {
    return {
      color: SAGE_LINE,
      opacity: 0.55,
      emissive: "#000000",
      emissiveIntensity: 0,
    };
  }
  if (visual === "idle") {
    return {
      color: IDLE_FILL,
      opacity: 1,
      emissive: selected ? SAGE : SAGE_LINE,
      emissiveIntensity: selected ? 0.22 : 0.08,
    };
  }
  if (visual === "reasoning") {
    return {
      color: SAGE,
      opacity: 0.55,
      emissive: SAGE,
      emissiveIntensity: 0.4,
    };
  }
  return {
    color: SAGE,
    opacity: 1,
    emissive: SAGE,
    emissiveIntensity: 0.6,
  };
}

/**
 * Frame the camera on the hanging canopy (side-front so −Y depth reads).
 */
function FitCamera({ nodes }: { nodes: LaidOutNode[] }) {
  const { camera, controls } = useThree();
  const fittedKey = useRef("");

  useEffect(() => {
    if (nodes.length === 0) {
      return;
    }
    const key = nodes.map((n) => n.data.id).join(",");
    if (key === fittedKey.current) {
      return;
    }
    fittedKey.current = key;

    const box = new THREE.Box3();
    for (const n of nodes) {
      box.expandByPoint(new THREE.Vector3(n.x, n.y, n.z));
    }
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const span = Math.max(size.x, size.y * 1.15, size.z * 1.1, 52);
    const dist = span * 1.2;

    camera.position.set(
      center.x + dist * 0.05,
      center.y + dist * 0.38,
      center.z + dist * 1.05,
    );
    camera.near = 0.5;
    camera.far = Math.max(4000, dist * 10);
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

/**
 * Soft pulse scale for live agent cores.
 */
function LivePulse({ live, children }: { live: boolean; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!ref.current || !live) {
      if (ref.current) {
        ref.current.scale.setScalar(1);
      }
      return;
    }
    const t = clock.getElapsedTime();
    const s = 1 + Math.sin(t * 2.2) * 0.07;
    ref.current.scale.setScalar(s);
  });
  return <group ref={ref}>{children}</group>;
}

type AgentNodeMeshProps = {
  node: LaidOutNode;
  agent: AgentRecord;
  visual: NodeVisual;
  selected: boolean;
  onHover: (node: LaidOutNode, screen: { x: number; y: number }) => void;
  onLeave: () => void;
  onClick: (agentId: string) => void;
};

/**
 * Single agent glyph in the 3D forest.
 */
function AgentNodeMesh({
  node,
  agent,
  visual,
  selected,
  onHover,
  onLeave,
  onClick,
}: AgentNodeMeshProps) {
  const live = isLiveVisual(visual);
  const r = node.depth === 0 ? (visual === "dormant" ? 3.4 : 4.8) : visual === "dormant" ? 2.6 : 3.5;
  const mat = visualMaterial(visual, selected);
  const { gl } = useThree();

  return (
    <group position={[node.x, node.y, node.z]}>
      <LivePulse live={live}>
        <mesh
          castShadow
          onPointerOver={(e) => {
            e.stopPropagation();
            const rect = gl.domElement.getBoundingClientRect();
            onHover(node, {
              x: e.clientX - rect.left,
              y: e.clientY - rect.top,
            });
          }}
          onPointerOut={(e) => {
            e.stopPropagation();
            onLeave();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onClick(agent.id);
          }}
        >
          <sphereGeometry args={[r, 28, 28]} />
          <meshStandardMaterial
            color={mat.color}
            transparent={mat.opacity < 1}
            opacity={mat.opacity}
            emissive={mat.emissive}
            emissiveIntensity={mat.emissiveIntensity}
            roughness={0.48}
            metalness={0.06}
            wireframe={visual === "dormant"}
          />
        </mesh>
        {visual === "both" ? (
          <mesh>
            <sphereGeometry args={[r * 0.42, 16, 16]} />
            <meshStandardMaterial color={BONE} roughness={0.55} />
          </mesh>
        ) : null}
        {live ? (
          <mesh>
            <sphereGeometry args={[r * 1.65, 16, 16]} />
            <meshBasicMaterial
              color={SAGE}
              transparent
              opacity={0.14}
              depthWrite={false}
            />
          </mesh>
        ) : null}
        {selected ? (
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <ringGeometry args={[r * 1.4, r * 1.65, 40]} />
            <meshBasicMaterial color={SAGE_DEEP} side={THREE.DoubleSide} />
          </mesh>
        ) : null}
      </LivePulse>
      <GraphLabel
        position={[0, -r - 1.2, 0]}
        color={visual === "dormant" ? "#b0b8a6" : "#5c6b52"}
        fontSize={node.depth === 0 ? 3.2 : 2.5}
      >
        {agent.name}
      </GraphLabel>
    </group>
  );
}

/**
 * Full-page 3D agent forest — orbit, hover details, click opens chat.
 */
export function AgentGraph3D({ entranceKey, className }: AgentGraph3DProps) {
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
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const terminalsQuery = useQuery({
    queryKey: ["nas", "terminals"],
    queryFn: () => nas.listTerminals(),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const agents = agentsQuery.data;
  const agentsById = useMemo(() => {
    const map = new Map<string, AgentRecord>();
    if (agents) {
      for (const a of agents) {
        map.set(a.id, a);
      }
    }
    return map;
  }, [agents]);

  const layout = useMemo(() => {
    if (!agents || agents.length === 0) {
      return null;
    }
    const forest = buildTree(agents);
    if (forest.length === 0) {
      return null;
    }
    return layoutForest3d(forest, 34, 52);
  }, [agents]);

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

  const scheduleDetails = (node: LaidOutNode, screen: { x: number; y: number }) => {
    clearCloseTimer();
    if (selectedId === node.data.id) {
      setAnchor(screen);
      return;
    }
    clearDetailTimer();
    detailTimerRef.current = window.setTimeout(() => {
      setSelectedId(node.data.id);
      setAnchor(screen);
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
        <p className="text-[13px] text-ink-muted">Could not load agents.</p>
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

  if (agents.length === 0 || !layout) {
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
      <GraphSpace key={entranceKey} interactive cameraPosition={[20, 60, 150]}>
        <FitCamera nodes={layout.nodes} />
        {layout.links.map((link) => (
          <Line
            key={`${link.source.data.id}-${link.target.data.id}`}
            points={[
              [link.source.x, link.source.y, link.source.z],
              [link.target.x, link.target.y, link.target.z],
            ]}
            color={SAGE_LINE}
            lineWidth={1.8}
            transparent
            opacity={0.7}
          />
        ))}
        {layout.nodes.map((node) => {
          const agent = agentsById.get(node.data.id);
          if (!agent) {
            throw new Error(`layout node missing agent record: ${node.data.id}`);
          }
          const visual = visualState(agent, runningMap[agent.id]);
          return (
            <AgentNodeMesh
              key={agent.id}
              node={node}
              agent={agent}
              visual={visual}
              selected={selectedId === agent.id}
              onHover={scheduleDetails}
              onLeave={scheduleClose}
              onClick={(id) => {
                hideDetails();
                openAgent(id);
              }}
            />
          );
        })}
      </GraphSpace>

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
    </div>
  );
}
