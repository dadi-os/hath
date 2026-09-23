import { MemoryGraph3D } from "./MemoryGraph3D";

export type MemoryGraphProps = {
  mode: "full" | "preview";
  entranceKey: string;
  className?: string;
};

/**
 * Yaad knowledge graph page surface.
 * Full mode renders the 3D force graph; preview is unused (home uses MemoryCounters).
 */
export function MemoryGraph({
  mode,
  entranceKey,
  className,
}: MemoryGraphProps) {
  if (mode === "preview") {
    return null;
  }
  return <MemoryGraph3D entranceKey={entranceKey} className={className} />;
}
