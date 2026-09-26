import { type ReactNode, Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useThemeTokens } from "../../hooks/useThemeTokens";

export type GraphSpaceProps = {
  /** When true, enable orbit / zoom / pan. */
  interactive: boolean;
  className?: string;
  children: ReactNode;
  /** Camera position at mount. */
  cameraPosition?: [number, number, number];
  /** Far plane for large graphs. */
  cameraFar?: number;
};

/**
 * Shared R3F shell for graph spaces: a transparent canvas over the page background,
 * fog in the page's `--bone` color (so the far side fades into the page in either
 * theme), lights, and orbit controls when interactive. Children own camera framing
 * and set the fog range each frame.
 */
export function GraphSpace({
  interactive,
  className,
  children,
  cameraPosition = [0, 70, 140],
  cameraFar = 4000,
}: GraphSpaceProps) {
  const { "--bone": bone } = useThemeTokens(["--bone"]);
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
        <fog attach="fog" args={[bone, 80, 520]} />
        <ambientLight intensity={0.72} />
        <directionalLight position={[50, 90, 40]} intensity={0.7} />
        <directionalLight position={[-40, 30, -50]} intensity={0.28} />
        <hemisphereLight args={["#fafaf7", "#b9c9ab", 0.35]} />
        <Suspense fallback={null}>{children}</Suspense>
        {interactive ? (
          <OrbitControls
            makeDefault
            enableDamping
            dampingFactor={0.08}
            minDistance={20}
            maxDistance={1100}
          />
        ) : null}
      </Canvas>
    </div>
  );
}
