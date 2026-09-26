import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Billboard, Text } from "@react-three/drei";
import * as THREE from "three";
import { useThemeTokens } from "../../../hooks/useThemeTokens";
import type { ForceEdge, ForceLinkResolved, ForceNode, SyncedForceGraph } from "./simulation";

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
 * size. Each label scales with its own distance and the canvas height, so every
 * label has the same on-screen size, near or far, on a page or a tile.
 */
const LABEL_DISTANCE = 210;
const LABEL_VIEWPORT = 760;
/** Label font size in world units at the reference distance. */
const LABEL_SIZE = 2.4;
/** Screen-constant gap between a node's silhouette and its label, in label-scaled units. */
const LABEL_GAP = 0.9;
/** Radians per second the camera circles the graph while idle. */
const ORBIT_SPEED = 0.12;
/** Node scale targets: focused nodes pop, hovered nodes lift. */
const FOCUS_SCALE = 1.35;
const HOVER_SCALE = 1.2;
/** Spring constants for node scale; underdamped so focus reads as a pop. */
const SPRING_STIFFNESS = 170;
const SPRING_DAMPING = 15;
/** Exponential easing rates (per second) for fades and the link sweep. */
const FADE_RATE = 9;
const SWEEP_RATE = 7;
/** Link brightness the near end must reach before the sweep continues to the far end. */
const SWEEP_HANDOFF = 0.75;
/** Exponential rate (per second) of the camera flight to a focused node. */
const FLIGHT_RATE = 4;
/** Flight is done once the camera is this close (fraction of its distance) to where it is heading. */
const FLIGHT_ARRIVED = 0.02;
/** Link brightness toward a hovered node. */
const HOVER_LINK = 0.6;
const THEME = [
  "--bone",
  "--sage-line",
  "--sage-deep",
  "--rule",
  "--ink-muted",
] as const;

/** Surface material for one node, before hover and focus effects. */
export type ForceGraphNodeLook = {
  /** Base and emissive color. */
  color: string;
  /** Resting opacity; unrelated nodes fade below this while another node is focused. */
  opacity: number;
  /** Resting self-glow; hover and focus add to it. */
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
  /**
   * Clicked node. It pops, the camera flies in until its neighborhood fills the view,
   * its links light up sweeping outward and gain `edgeLabel` annotations, and
   * unrelated nodes fade back. Orbiting then revolves around it; clearing it lets
   * the idle framing glide back out.
   */
  focusId: string | null;
  /** Freeze the idle orbit and framing (e.g. while a details popover is open). Hover always freezes. */
  hold: boolean;
  /** Sphere radius in world units. */
  radius: (node: ForceNode<R>) => number;
  /** Resting surface material. */
  look: (node: ForceNode<R>) => ForceGraphNodeLook;
  /** Text of the label under the node. */
  labelText: (node: ForceNode<R>) => string;
  /** Ids that always carry a label. The hovered node and the focus neighborhood are labelled too. */
  pinnedLabels: Set<string>;
  /** Annotation drawn on a link of the focused node; omit for no annotations. */
  edgeLabel?: (link: ForceLinkResolved<R, E>, focusId: string) => string;
  /** Extra meshes drawn inside the node's group (halos, cores). */
  decorate?: (node: ForceNode<R>, radius: number) => ReactNode;
  /** Node clicked; `at` is the node's screen position. Omit for a view-only graph. */
  onNodeClick?: (node: ForceNode<R>, at: ForceGraphPoint) => void;
  /** Pointer entered a node; `at` is the node's screen position. */
  onNodeHover?: (node: ForceNode<R>, at: ForceGraphPoint) => void;
  /** Pointer left a node. */
  onNodeLeave?: () => void;
  /** Camera finished flying to the focused node; `at` is its screen position there. */
  onFocusArrive?: (node: ForceNode<R>, at: ForceGraphPoint) => void;
};

/** Orbit controls surface this scene drives (GraphSpace registers them as default). */
type Orbit = {
  target: THREE.Vector3;
  addEventListener: (type: "start", listener: () => void) => void;
  removeEventListener: (type: "start", listener: () => void) => void;
};

/** Troika text mesh fields animated per frame. */
type FadingText = THREE.Mesh & { fillOpacity: number; outlineOpacity: number };


/** Per-node animation state carried across frames. */
type NodeMotion = { scale: number; velocity: number; visible: number; glow: number };

/** Scale a text group so it keeps one on-screen size at its distance from the camera. */
function screenScale(camera: THREE.Camera, at: THREE.Vector3, height: number): number {
  return (camera.position.distanceTo(at) * LABEL_VIEWPORT) / height / LABEL_DISTANCE;
}

/**
 * Live 3D force-directed graph, rendered inside a `GraphSpace`.
 *
 * Ticks the simulation once per frame and writes positions, colors, and fades
 * straight into meshes and one edge buffer, so hover and focus animate smoothly
 * without re-rendering React. Nodes grow in when they first appear. Until the user
 * grabs the camera it slowly circles and keeps the whole graph framed, freezing the
 * instant a node is hovered or `hold` is set so targets stay under the pointer;
 * fog follows the camera so the far side fades. Labels draw on top without fog,
 * keep one on-screen size, and sit just below their node from any viewing angle.
 */
export function ForceGraph<R extends { id: string }, E extends ForceEdge>({
  sim,
  graph,
  focusId,
  hold,
  radius,
  look,
  labelText,
  pinnedLabels,
  edgeLabel,
  decorate,
  onNodeClick,
  onNodeHover,
  onNodeLeave,
  onFocusArrive,
}: ForceGraphProps<R, E>) {
  const { camera, controls, scene, gl, size } = useThree();
  const theme = useThemeTokens(THEME);
  const groups = useRef(new Map<string, THREE.Group>());
  const meshes = useRef(new Map<string, THREE.Mesh>());
  const labelGroups = useRef(new Map<string, THREE.Group>());
  const labelTexts = useRef(new Map<string, FadingText>());
  const noteGroups = useRef(new Map<string, THREE.Group>());
  const noteTexts = useRef(new Map<string, FadingText>());
  const motion = useRef(new Map<string, NodeMotion>());
  const userMoved = useRef(false);
  const arrivedAt = useRef<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const sphere = useMemo(() => new THREE.SphereGeometry(1, 20, 16), []);
  const textMaterial = useMemo(
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
  const scratch = useMemo(
    () => ({
      centroid: new THREE.Vector3(),
      target: new THREE.Vector3(),
      offset: new THREE.Vector3(),
      down: new THREE.Vector3(),
      mid: new THREE.Vector3(),
      project: new THREE.Vector3(),
      color: new THREE.Color(),
    }),
    [],
  );
  const edgeColors = useMemo(
    () => ({
      base: new THREE.Color(theme["--sage-line"]),
      focus: new THREE.Color(theme["--sage-deep"]),
      dim: new THREE.Color(theme["--rule"]),
    }),
    [theme],
  );

  useEffect(() => () => sphere.dispose(), [sphere]);
  useEffect(() => () => textMaterial.dispose(), [textMaterial]);

  useEffect(() => {
    const orbit = controls as unknown as Orbit | null;
    if (!orbit) {
      return;
    }
    const release = () => {
      userMoved.current = true;
    };
    orbit.addEventListener("start", release);
    return () => orbit.removeEventListener("start", release);
  }, [controls]);

  const edges = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const length = graph.links.length * 6;
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(length), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(length), 3));
    return { geometry, brightness: new Float32Array(graph.links.length * 2) };
  }, [graph.links]);

  useEffect(() => () => edges.geometry.dispose(), [edges]);

  useEffect(() => {
    const live = new Set(graph.nodes.map((n) => n.id));
    for (const id of motion.current.keys()) {
      if (!live.has(id)) {
        motion.current.delete(id);
      }
    }
  }, [graph.nodes]);

  const focus = useMemo(() => {
    const ids = new Set<string>();
    if (focusId) {
      ids.add(focusId);
      for (const l of graph.links) {
        if (l.source.id === focusId) {
          ids.add(l.target.id);
        } else if (l.target.id === focusId) {
          ids.add(l.source.id);
        }
      }
    }
    return ids;
  }, [graph.links, focusId]);

  const annotated = useMemo(
    () =>
      focusId && edgeLabel
        ? graph.links.filter((l) => l.source.id === focusId || l.target.id === focusId)
        : [],
    [graph.links, focusId, edgeLabel],
  );

  useEffect(() => {
    gl.domElement.style.cursor = hoveredId && onNodeClick ? "pointer" : "";
  }, [gl, hoveredId, onNodeClick]);

  /** Canvas-relative screen position of a node's center. */
  const toScreen = (node: ForceNode<R>): ForceGraphPoint => {
    scratch.project.set(node.x, node.y, node.z).project(camera);
    return {
      x: ((scratch.project.x + 1) / 2) * size.width,
      y: ((1 - scratch.project.y) / 2) * size.height,
    };
  };

  useEffect(() => {
    arrivedAt.current = null;
  }, [focusId]);

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    if (sim.alpha() > sim.alphaMin()) {
      sim.tick();
    }
    if (graph.nodes.length === 0) {
      return;
    }
    const { centroid, target, offset, down, mid, color } = scratch;

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

    const orbit = controls as unknown as Orbit | null;
    const pivot = orbit ? orbit.target : target;
    const fov = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov);
    const focused = focusId === null ? undefined : graph.nodes.find((n) => n.id === focusId);
    if (focused) {
      let reach = 0;
      for (const n of graph.nodes) {
        if (focus.has(n.id)) {
          reach = Math.max(reach, Math.hypot(n.x - focused.x, n.y - focused.y, n.z - focused.z));
        }
      }
      const want = (reach + 20) / Math.sin(fov / 2);
      const k = 1 - Math.exp(-dt * FLIGHT_RATE);
      mid.set(focused.x, focused.y, focused.z);
      const gap = pivot.distanceTo(mid);
      offset.copy(camera.position).sub(pivot);
      const distance = offset.length();
      pivot.lerp(mid, k);
      offset.setLength(distance + (want - distance) * k);
      camera.position.copy(pivot).add(offset);
      if (!orbit) {
        camera.lookAt(pivot);
      }
      const arrived =
        gap < distance * FLIGHT_ARRIVED && Math.abs(want - distance) < distance * FLIGHT_ARRIVED;
      if (arrived && arrivedAt.current !== focused.id) {
        arrivedAt.current = focused.id;
        onFocusArrive?.(focused, toScreen(focused));
      }
    } else if (!userMoved.current && !hold && hoveredId === null) {
      pivot.lerp(centroid, 0.08);
      const want = (extent + 12) / Math.sin(fov / 2);
      offset.copy(camera.position).sub(pivot);
      offset.applyAxisAngle(THREE.Object3D.DEFAULT_UP, ORBIT_SPEED * dt);
      offset.setLength(offset.length() + (want - offset.length()) * 0.08);
      camera.position.copy(pivot).add(offset);
      if (!orbit) {
        camera.lookAt(pivot);
      }
    }

    const fade = 1 - Math.exp(-dt * FADE_RATE);
    down.set(0, -1, 0).applyQuaternion(camera.quaternion);
    for (const n of graph.nodes) {
      const mesh = meshes.current.get(n.id);
      if (!mesh) {
        continue;
      }
      let m = motion.current.get(n.id);
      if (!m) {
        m = { scale: 0, velocity: 0, visible: 1, glow: 0 };
        motion.current.set(n.id, m);
      }
      const focused = n.id === focusId;
      const hovered = n.id === hoveredId;
      const wantScale = focused ? FOCUS_SCALE : hovered ? HOVER_SCALE : 1;
      m.velocity += ((wantScale - m.scale) * SPRING_STIFFNESS - m.velocity * SPRING_DAMPING) * dt;
      m.scale += m.velocity * dt;
      m.visible += ((focusId === null || focus.has(n.id) ? 1 : 0) - m.visible) * fade;
      m.glow += ((focused ? 0.45 : hovered ? 0.3 : 0) - m.glow) * fade;

      const base = look(n);
      const r = radius(n) * Math.max(m.scale, 0.01);
      mesh.scale.setScalar(r);
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.opacity = base.opacity * (0.15 + 0.85 * m.visible);
      material.emissiveIntensity = base.emissiveIntensity + m.glow;

      const labelGroup = labelGroups.current.get(n.id);
      const labelText = labelTexts.current.get(n.id);
      if (labelGroup && labelText) {
        const s = screenScale(camera, mid.set(n.x, n.y, n.z), size.height);
        labelGroup.scale.setScalar(s);
        labelGroup.position.copy(down).multiplyScalar(r + LABEL_GAP * s);
        labelText.fillOpacity = 0.3 + 0.7 * m.visible;
        labelText.outlineOpacity = 0.9 * m.visible;
      }
    }

    const sweep = 1 - Math.exp(-dt * SWEEP_RATE);
    const positions = edges.geometry.getAttribute("position") as THREE.BufferAttribute;
    const colors = edges.geometry.getAttribute("color") as THREE.BufferAttribute;
    const bright = edges.brightness;
    graph.links.forEach((l, i) => {
      positions.setXYZ(i * 2, l.source.x, l.source.y, l.source.z);
      positions.setXYZ(i * 2 + 1, l.target.x, l.target.y, l.target.z);

      const fromTarget = l.target.id === focusId;
      const near = fromTarget ? i * 2 + 1 : i * 2;
      const far = fromTarget ? i * 2 : i * 2 + 1;
      let wantNear = 0;
      let wantFar = 0;
      if (focusId !== null) {
        if (l.source.id === focusId || fromTarget) {
          wantNear = 1;
          wantFar = bright[near] > SWEEP_HANDOFF ? 1 : bright[far];
        } else {
          wantNear = -1;
          wantFar = -1;
        }
      } else if (hoveredId !== null && (l.source.id === hoveredId || l.target.id === hoveredId)) {
        wantNear = HOVER_LINK;
        wantFar = HOVER_LINK;
      }
      bright[near] += (wantNear - bright[near]) * sweep;
      bright[far] += (wantFar - bright[far]) * sweep;
      for (const v of [i * 2, i * 2 + 1]) {
        const b = bright[v];
        color.copy(edgeColors.base).lerp(b >= 0 ? edgeColors.focus : edgeColors.dim, Math.abs(b));
        colors.setXYZ(v, color.r, color.g, color.b);
      }

      const noteGroup = noteGroups.current.get(l.id);
      const noteText = noteTexts.current.get(l.id);
      if (noteGroup && noteText) {
        mid.set(
          (l.source.x + l.target.x) / 2,
          (l.source.y + l.target.y) / 2,
          (l.source.z + l.target.z) / 2,
        );
        noteGroup.position.copy(mid);
        noteGroup.scale.setScalar(screenScale(camera, mid, size.height));
        const shown = THREE.MathUtils.clamp((bright[far] - 0.7) / 0.3, 0, 1);
        noteText.fillOpacity = shown;
        noteText.outlineOpacity = 0.9 * shown;
      }
    });
    positions.needsUpdate = true;
    colors.needsUpdate = true;

    const d = camera.position.distanceTo(pivot);
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.near = Math.max(1, d - extent * 0.3);
      scene.fog.far = d + extent * 2.5 + 60;
    }
  });

  return (
    <>
      <lineSegments geometry={edges.geometry} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent opacity={0.85} />
      </lineSegments>
      {annotated.map((link) => (
        <group
          key={link.id}
          ref={(g) => {
            if (g) {
              noteGroups.current.set(link.id, g);
            } else {
              noteGroups.current.delete(link.id);
            }
          }}
        >
          <Billboard follow>
            <Text
              ref={(t: FadingText | null) => {
                if (t) {
                  noteTexts.current.set(link.id, t);
                } else {
                  noteTexts.current.delete(link.id);
                }
              }}
              material={textMaterial}
              renderOrder={11}
              fontSize={LABEL_SIZE * 0.8}
              color={theme["--sage-deep"]}
              anchorX="center"
              anchorY="middle"
              outlineWidth={0.16}
              outlineColor={theme["--bone"]}
              fillOpacity={0}
              outlineOpacity={0}
            >
              {edgeLabel!(link, focusId!)}
            </Text>
          </Billboard>
        </group>
      ))}
      {graph.nodes.map((node) => {
        const surface = look(node);
        const labelled = pinnedLabels.has(node.id) || focus.has(node.id) || node.id === hoveredId;
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
              scale={0.01}
              ref={(m) => {
                if (m) {
                  meshes.current.set(node.id, m);
                } else {
                  meshes.current.delete(node.id);
                }
              }}
              onClick={(e) => {
                if (!onNodeClick) {
                  return;
                }
                e.stopPropagation();
                onNodeClick(node, toScreen(node));
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                setHoveredId(node.id);
                onNodeHover?.(node, toScreen(node));
              }}
              onPointerOut={() => {
                setHoveredId((id) => (id === node.id ? null : id));
                onNodeLeave?.();
              }}
            >
              <meshStandardMaterial
                color={surface.color}
                emissive={surface.color}
                roughness={0.55}
                metalness={0.05}
                transparent
                wireframe={surface.wireframe}
              />
            </mesh>
            {decorate?.(node, radius(node))}
            {labelled ? (
              <group
                ref={(g) => {
                  if (g) {
                    labelGroups.current.set(node.id, g);
                  } else {
                    labelGroups.current.delete(node.id);
                  }
                }}
              >
                <Billboard follow>
                  <Text
                    ref={(t: FadingText | null) => {
                      if (t) {
                        labelTexts.current.set(node.id, t);
                      } else {
                        labelTexts.current.delete(node.id);
                      }
                    }}
                    material={textMaterial}
                    renderOrder={10}
                    fontSize={node.id === focusId ? LABEL_SIZE * 1.2 : LABEL_SIZE}
                    color={theme["--ink-muted"]}
                    anchorX="center"
                    anchorY="top"
                    maxWidth={80}
                    textAlign="center"
                    outlineWidth={0.14}
                    outlineColor={theme["--bone"]}
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
