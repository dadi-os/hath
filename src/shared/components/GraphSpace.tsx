import { type ReactNode, Suspense } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useRef } from "react";
import * as THREE from "three";

const FOG = "#f4f6f0";
const GROUND = "#e8ede3";

export type GraphSpaceProps = {
  /** When true, enable orbit / zoom / pan. */
  interactive: boolean;
  className?: string;
  children: ReactNode;
  /** Camera position at mount. */
  cameraPosition?: [number, number, number];
  /** Far plane for large forests. */
  cameraFar?: number;
};

/**
 * Soft ground disc so depth reads in the scene.
 */
function Ground() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.5, 0]} receiveShadow>
      <circleGeometry args={[720, 72]} />
      <meshStandardMaterial
        color={GROUND}
        transparent
        opacity={0.55}
        roughness={1}
        metalness={0}
      />
    </mesh>
  );
}

/**
 * Shared R3F shell for full-page graph spaces.
 * OrbitControls only when interactive; otherwise a static framed view.
 */
export function GraphSpace({
  interactive,
  className,
  children,
  cameraPosition = [0, 70, 140],
  cameraFar = 4000,
}: GraphSpaceProps) {
  const rootClass = [
    "relative h-full min-h-0 w-full",
    interactive ? "" : "pointer-events-none",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={rootClass}>
      <Canvas
        className="h-full w-full touch-none"
        dpr={[1, 1.75]}
        gl={{ antialias: true, alpha: true }}
        camera={{
          position: cameraPosition,
          fov: 40,
          near: 0.5,
          far: cameraFar,
        }}
        style={{ background: "transparent" }}
      >
        <color attach="background" args={[FOG]} />
        <fog attach="fog" args={[FOG, 80, 520]} />
        <ambientLight intensity={0.72} />
        <directionalLight position={[50, 90, 40]} intensity={0.7} castShadow />
        <directionalLight position={[-40, 30, -50]} intensity={0.28} />
        <hemisphereLight args={["#fafaf7", "#b9c9ab", 0.35]} />
        <Ground />
        <Suspense fallback={null}>{children}</Suspense>
        {interactive ? (
          <OrbitControls
            makeDefault
            enableDamping
            dampingFactor={0.08}
            minDistance={20}
            maxDistance={1100}
            maxPolarAngle={Math.PI * 0.88}
            target={[0, -20, 20]}
          />
        ) : null}
      </Canvas>
    </div>
  );
}

/**
 * CameraDistanceReporter publishes whether the camera is far enough to hide
 * non-selected labels. Threshold should sit well above the fit-camera distance.
 */
export function CameraDistanceReporter({
  onFar,
  farThreshold,
}: {
  onFar: (far: boolean) => void;
  farThreshold: number;
}) {
  const { camera, controls } = useThree();
  const last = useRef(false);
  useFrame(() => {
    const orbit = controls as { target?: THREE.Vector3 } | null;
    if (!orbit?.target) {
      return;
    }
    const far = camera.position.distanceTo(orbit.target) >= farThreshold;
    if (far !== last.current) {
      last.current = far;
      onFar(far);
    }
  });
  return null;
}
