import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Billboard, Text } from "@react-three/drei";
import * as THREE from "three";
import { useThemeTokens } from "../../../hooks/useThemeTokens";
import type { ForceEdge, ForceNode, SyncedForceGraph } from "./simulation";

export {
  syncForceSimulation,
  type ForceEdge,
  type ForceGraphSimulation,
  type ForceLinkDatum,
  type ForceLinkResolved,
  type ForceNode,
  type SyncedForceGraph,
} from "./simulation";

/**
 * Camera distance and canvas height (px) at which labels render at their authored
 * size. Each label scales with its own node's distance and the canvas height, so
 * every label has the same on-screen size, near or far, on a page or a tile.
 */
const LABEL_DISTANCE = 210;
const LABEL_VIEWPORT = 760;
/** Label font size in world units at the reference distance. */
const LABEL_SIZE = 2.4;
/** Screen-constant gap between a node's silhouette and its label, in label-scaled units. */
const LABEL_GAP = 0.9;
/** Radians per second the camera circles the graph before the user takes over. */
const ORBIT_SPEED = 0.12;
const THEME = ["--bone", "--sage-line", "--sage-deep", "--rule", "--ink-muted", "--ink-ghost"] as const;

/** Surface material for one node. */
export type ForceGraphNodeLook = {
  /** Base and emissive color. */
  color: string;
  /** Below 1 renders transparent. */
  opacity: number;
  /** Self-glow strength; raise for selected or live nodes. */
  emissiveIntensity: number;
  /** Draw the sphere as a wire cage (used for dormant agents). */
  wireframe: boolean;
};

/** Screen point relative to the canvas, for anchoring popovers. */
export type ForceGraphPoint = { x: number; y: number };

export type ForceGraphProps<R extends { id: string }, E extends ForceEdge> = {
  /** Running simulation; advanced one tick per frame while it is warm. */
  sim: { tick: () => unknown; alpha: () => number; alphaMin: () => number };
  /** Output of `syncForceSimulation` for the current data. */
  graph: SyncedForceGraph<R, E>;
  /** Focused node: it, its neighbors, and their links stay bright; the rest dims. */
  selectedId: string | null;
  /** Sphere radius in world units. */
  radius: (node: ForceNode<R>) => number;
  /** Surface material; `dimmed` is true when another node is focused. */
  look: (node: ForceNode<R>, state: { selected: boolean; dimmed: boolean }) => ForceGraphNodeLook;
  /** Text of the label under the node. */
  labelText: (node: ForceNode<R>) => string;
  /** Ids labelled while nothing is focused. Focus and hover are always labelled. */
  pinnedLabels: Set<string>;
  /** Extra meshes drawn inside the node's group (halos, cores). */
  decorate?: (node: ForceNode<R>, radius: number) => ReactNode;
  /** Node clicked; omit for a view-only graph (also drops the pointer cursor). */
  onNodeClick?: (node: ForceNode<R>, at: ForceGraphPoint) => void;
  /** Pointer entered a node. */
  onNodeHover?: (node: ForceNode<R>, at: ForceGraphPoint) => void;
  /** Pointer left a node. */
  onNodeLeave?: () => void;
};

/** Orbit controls surface this scene drives (GraphSpace registers them as default). */
type Orbit = {
  target: THREE.Vector3;
  autoRotate: boolean;
  autoRotateSpeed: number;
  addEventListener: (type: "start", listener: () => void) => void;
  removeEventListener: (type: "start", listener: () => void) => void;
};

/** A mounted label and the radius of the node it hangs from. */
type LabelMount = { group: THREE.Group; radius: number };

/**
 * Live 3D force-directed graph, rendered inside a `GraphSpace`.
 *
 * Ticks the simulation once per frame and writes positions straight into meshes and
 * one edge buffer, so React only re-renders on membership, focus, look, or theme
 * changes. Until the user grabs the camera it slowly circles and keeps the whole
 * graph framed; without orbit controls (non-interactive spaces) it always does. Fog
 * follows the camera so the far side fades. Labels draw on top of everything, ignore
 * fog, keep a constant screen size, and sit just below their node on screen from any
 * viewing angle.
 */
export function ForceGraph<R extends { id: string }, E extends ForceEdge>({
  sim,
  graph,
  selectedId,
  radius,
  look,
  labelText,
  pinnedLabels,
  decorate,
  onNodeClick,
  onNodeHover,
  onNodeLeave,
}: ForceGraphProps<R, E>) {
  const { camera, controls, scene, gl, size } = useThree();
  const theme = useThemeTokens(THEME);
  const groups = useRef(new Map<string, THREE.Group>());
  const labels = useRef(new Map<string, LabelMount>());
  const userMoved = useRef(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const sphere = useMemo(() => new THREE.SphereGeometry(1, 20, 16), []);
  const labelMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        depthTest: false,
        depthWrite: false,
        fog: false,
        transparent: true,
        toneMapped: false,
      }),
    [],
  );
  const centroid = useMemo(() => new THREE.Vector3(), []);
  const target = useMemo(() => new THREE.Vector3(), []);
  const offset = useMemo(() => new THREE.Vector3(), []);
  const down = useMemo(() => new THREE.Vector3(), []);
  const edgeColors = useMemo(
    () => ({
      base: new THREE.Color(theme["--sage-line"]),
      focus: new THREE.Color(theme["--sage-deep"]),
      dim: new THREE.Color(theme["--rule"]),
    }),
    [theme],
  );

  useEffect(() => () => sphere.dispose(), [sphere]);
  useEffect(() => () => labelMaterial.dispose(), [labelMaterial]);

  useEffect(() => {
    const orbit = controls as unknown as Orbit | null;
    if (!orbit) {
      return;
    }
    orbit.autoRotate = !userMoved.current;
    orbit.autoRotateSpeed = (ORBIT_SPEED * 30) / Math.PI;
    const release = () => {
      userMoved.current = true;
      orbit.autoRotate = false;
    };
    orbit.addEventListener("start", release);
    return () => orbit.removeEventListener("start", release);
  }, [controls]);

  const edgeGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const length = graph.links.length * 6;
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(length), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(length), 3));
    return geometry;
  }, [graph.links]);

  useEffect(() => () => edgeGeometry.dispose(), [edgeGeometry]);

  const focus = useMemo(() => {
    const ids = new Set<string>();
    if (selectedId) {
      ids.add(selectedId);
      for (const l of graph.links) {
        if (l.source.id === selectedId) {
          ids.add(l.target.id);
        } else if (l.target.id === selectedId) {
          ids.add(l.source.id);
        }
      }
    }
    return ids;
  }, [graph.links, selectedId]);

  useEffect(() => {
    const colors = edgeGeometry.getAttribute("color") as THREE.BufferAttribute;
    graph.links.forEach((l, i) => {
      const touches =
        selectedId !== null && (l.source.id === selectedId || l.target.id === selectedId);
      const color =
        selectedId === null ? edgeColors.base : touches ? edgeColors.focus : edgeColors.dim;
      colors.setXYZ(i * 2, color.r, color.g, color.b);
      colors.setXYZ(i * 2 + 1, color.r, color.g, color.b);
    });
    colors.needsUpdate = true;
  }, [edgeGeometry, edgeColors, graph.links, selectedId]);

  useEffect(() => {
    gl.domElement.style.cursor = hoveredId && onNodeClick ? "pointer" : "";
  }, [gl, hoveredId, onNodeClick]);

  useFrame((_, delta) => {
    if (sim.alpha() > sim.alphaMin()) {
      sim.tick();
    }
    if (graph.nodes.length === 0) {
      return;
    }

    centroid.set(0, 0, 0);
    for (const n of graph.nodes) {
      groups.current.get(n.id)?.position.set(n.x, n.y, n.z);
      centroid.x += n.x;
      centroid.y += n.y;
      centroid.z += n.z;
    }
    centroid.divideScalar(graph.nodes.length);
    let extent = 0;
    for (const n of graph.nodes) {
      extent = Math.max(extent, Math.hypot(n.x - centroid.x, n.y - centroid.y, n.z - centroid.z));
    }

    const positions = edgeGeometry.getAttribute("position") as THREE.BufferAttribute;
    graph.links.forEach((l, i) => {
      positions.setXYZ(i * 2, l.source.x, l.source.y, l.source.z);
      positions.setXYZ(i * 2 + 1, l.target.x, l.target.y, l.target.z);
    });
    positions.needsUpdate = true;

    const orbit = controls as unknown as Orbit | null;
    const pivot = orbit ? orbit.target : target;
    if (!userMoved.current) {
      pivot.lerp(centroid, 0.08);
      const fov = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov);
      const want = (extent + 12) / Math.sin(fov / 2);
      offset.copy(camera.position).sub(pivot);
      if (!orbit) {
        offset.applyAxisAngle(THREE.Object3D.DEFAULT_UP, ORBIT_SPEED * delta);
      }
      offset.setLength(offset.length() + (want - offset.length()) * 0.08);
      camera.position.copy(pivot).add(offset);
      if (!orbit) {
        camera.lookAt(pivot);
      }
    }

    const d = camera.position.distanceTo(pivot);
    const perUnitDistance = LABEL_VIEWPORT / size.height / LABEL_DISTANCE;
    down.set(0, -1, 0).applyQuaternion(camera.quaternion);
    for (const { group, radius: r } of labels.current.values()) {
      const node = group.parent;
      if (!node) {
        continue;
      }
      const scale = camera.position.distanceTo(node.position) * perUnitDistance;
      group.scale.setScalar(scale);
      group.position.copy(down).multiplyScalar(r + LABEL_GAP * scale);
    }
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.near = Math.max(1, d - extent * 0.3);
      scene.fog.far = d + extent * 2.5 + 60;
    }
  });

  return (
    <>
      <lineSegments geometry={edgeGeometry} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent opacity={0.85} />
      </lineSegments>
      {graph.nodes.map((node) => {
        const r = radius(node);
        const selected = node.id === selectedId;
        const dimmed = selectedId !== null && !focus.has(node.id);
        const surface = look(node, { selected, dimmed });
        const labelled =
          focus.has(node.id) ||
          node.id === hoveredId ||
          (selectedId === null && pinnedLabels.has(node.id));
        return (
          <group
            key={node.id}
            position={[node.x, node.y, node.z]}
            ref={(g) => {
              if (g) {
                groups.current.set(node.id, g);
              } else {
                groups.current.delete(node.id);
              }
            }}
          >
            <mesh
              geometry={sphere}
              scale={r}
              onClick={(e) => {
                if (!onNodeClick) {
                  return;
                }
                e.stopPropagation();
                const rect = gl.domElement.getBoundingClientRect();
                onNodeClick(node, { x: e.clientX - rect.left, y: e.clientY - rect.top });
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                setHoveredId(node.id);
                const rect = gl.domElement.getBoundingClientRect();
                onNodeHover?.(node, { x: e.clientX - rect.left, y: e.clientY - rect.top });
              }}
              onPointerOut={() => {
                setHoveredId((id) => (id === node.id ? null : id));
                onNodeLeave?.();
              }}
            >
              <meshStandardMaterial
                color={surface.color}
                emissive={surface.color}
                emissiveIntensity={surface.emissiveIntensity}
                roughness={0.55}
                metalness={0.05}
                transparent={surface.opacity < 1}
                opacity={surface.opacity}
                wireframe={surface.wireframe}
              />
            </mesh>
            {decorate?.(node, r)}
            {labelled ? (
              <group
                ref={(g) => {
                  if (g) {
                    labels.current.set(node.id, { group: g, radius: r });
                  } else {
                    labels.current.delete(node.id);
                  }
                }}
              >
                <Billboard follow>
                  <Text
                    material={labelMaterial}
                    renderOrder={10}
                    fontSize={selected ? LABEL_SIZE * 1.2 : LABEL_SIZE}
                    color={dimmed ? theme["--ink-ghost"] : theme["--ink-muted"]}
                    anchorX="center"
                    anchorY="top"
                    maxWidth={80}
                    textAlign="center"
                    outlineWidth={0.14}
                    outlineColor={theme["--bone"]}
                    outlineOpacity={0.9}
                  >
                    {labelText(node)}
                  </Text>
                </Billboard>
              </group>
            ) : null}
          </group>
        );
      })}
    </>
  );
}
