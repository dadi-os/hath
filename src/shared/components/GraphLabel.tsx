import { Billboard, Text } from "@react-three/drei";

export type GraphLabelProps = {
  children: string;
  /** Offset from the parent group origin. */
  position?: [number, number, number];
  color?: string;
  fontSize?: number;
  maxWidth?: number;
};

/**
 * Always-readable billboard label for graph nodes.
 * Uses troika Text so labels stay legible at fit-camera distances
 * (unlike CSS Html with distanceFactor, which shrinks to invisibility).
 */
export function GraphLabel({
  children,
  position = [0, -4.5, 0],
  color = "#6e7568",
  fontSize = 2.6,
  maxWidth = 36,
}: GraphLabelProps) {
  return (
    <Billboard position={position} follow>
      <Text
        fontSize={fontSize}
        color={color}
        anchorX="center"
        anchorY="top"
        maxWidth={maxWidth}
        textAlign="center"
        outlineWidth={0.12}
        outlineColor="#fafaf7"
        outlineOpacity={0.9}
      >
        {children}
      </Text>
    </Billboard>
  );
}
