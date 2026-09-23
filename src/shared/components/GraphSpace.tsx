import { type ReactNode, Suspense, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

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
 * Shared R3F shell for full-page graph spaces.
 * OrbitControls only when interactive; otherwise a static framed view.
 */
export function GraphSpace({
  interactive,
  className,
  children,
  cameraPosition = [0, 80, 160],
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
          fov: 42,
          near: 0.5,
          far: cameraFar,
        }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.85} />
        <directionalLight position={[40, 80, 30]} intensity={0.55} />
        <directionalLight position={[-30, 20, -40]} intensity={0.25} />
        <Suspense fallback={null}>{children}</Suspense>
        {interactive ? (
          <OrbitControls
            makeDefault
            enableDamping
            dampingFactor={0.08}
            minDistance={24}
            maxDistance={900}
            maxPolarAngle={Math.PI * 0.92}
          />
        ) : null}
      </Canvas>
    </div>
  );
}

/**
 * CameraDistanceReporter publishes whether the camera is far enough to hide
 * non-selected labels. No-ops until OrbitControls exposes a target.
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
