/**
 * Ambient typings for d3-force-3d (no published @types package).
 * Mirrors the d3-force API with an optional Z dimension.
 */
declare module "d3-force-3d" {
  export interface SimulationNodeDatum {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimulationLinkDatum<NodeDatum extends SimulationNodeDatum> {
    source: NodeDatum | string | number;
    target: NodeDatum | string | number;
    index?: number;
  }

  export interface Simulation<
    NodeDatum extends SimulationNodeDatum,
    LinkDatum extends SimulationLinkDatum<NodeDatum>,
  > {
    restart(): this;
    stop(): this;
    tick(iterations?: number): this;
    nodes(): NodeDatum[];
    nodes(nodes: NodeDatum[]): this;
    alpha(): number;
    alpha(alpha: number): this;
    alphaMin(): number;
    alphaMin(min: number): this;
    alphaDecay(): number;
    alphaDecay(decay: number): this;
    alphaTarget(): number;
    alphaTarget(target: number): this;
    velocityDecay(): number;
    velocityDecay(decay: number): this;
    force(name: string): Force<NodeDatum, LinkDatum> | undefined;
    force(name: string, force: Force<NodeDatum, LinkDatum> | null): this;
    find(x: number, y: number, z?: number, radius?: number): NodeDatum | undefined;
    on(typenames: string): ((...args: unknown[]) => void) | undefined;
    on(typenames: string, listener: ((...args: unknown[]) => void) | null): this;
  }

  export interface Force<
    NodeDatum extends SimulationNodeDatum,
    LinkDatum extends SimulationLinkDatum<NodeDatum>,
  > {
    (alpha: number): void;
    initialize?(nodes: NodeDatum[], random?: () => number): void;
  }

  export interface ForceLink<
    NodeDatum extends SimulationNodeDatum,
    LinkDatum extends SimulationLinkDatum<NodeDatum>,
  > extends Force<NodeDatum, LinkDatum> {
    links(): LinkDatum[];
    links(links: LinkDatum[]): this;
    id(id: (node: NodeDatum, i: number, nodes: NodeDatum[]) => string | number): this;
    distance(distance: number | ((link: LinkDatum) => number)): this;
    strength(strength: number | ((link: LinkDatum) => number)): this;
    iterations(iterations: number): this;
  }

  export interface ForceManyBody<
    NodeDatum extends SimulationNodeDatum,
  > extends Force<NodeDatum, never> {
    strength(strength: number | ((node: NodeDatum) => number)): this;
    distanceMin(distance: number): this;
    distanceMax(distance: number): this;
  }

  export interface ForceCenter<
    NodeDatum extends SimulationNodeDatum,
  > extends Force<NodeDatum, never> {
    x(x: number): this;
    y(y: number): this;
    z(z: number): this;
    strength(strength: number): this;
  }

  export interface ForceCollide<
    NodeDatum extends SimulationNodeDatum,
  > extends Force<NodeDatum, never> {
    radius(radius: number | ((node: NodeDatum) => number)): this;
    strength(strength: number): this;
    iterations(iterations: number): this;
  }

  export function forceSimulation<
    NodeDatum extends SimulationNodeDatum,
    LinkDatum extends SimulationLinkDatum<NodeDatum> = SimulationLinkDatum<NodeDatum>,
  >(nodes?: NodeDatum[], numDimensions?: number): Simulation<NodeDatum, LinkDatum>;

  export function forceLink<
    NodeDatum extends SimulationNodeDatum,
    LinkDatum extends SimulationLinkDatum<NodeDatum> = SimulationLinkDatum<NodeDatum>,
  >(links?: LinkDatum[]): ForceLink<NodeDatum, LinkDatum>;

  export function forceManyBody<
    NodeDatum extends SimulationNodeDatum,
  >(): ForceManyBody<NodeDatum>;

  export function forceCenter<
    NodeDatum extends SimulationNodeDatum,
  >(x?: number, y?: number, z?: number): ForceCenter<NodeDatum>;

  export function forceCollide<
    NodeDatum extends SimulationNodeDatum,
  >(radius?: number | ((node: NodeDatum) => number)): ForceCollide<NodeDatum>;

  /** Pulls each node toward a sphere of `radius` around (x, y, z). */
  export interface ForceRadial<
    NodeDatum extends SimulationNodeDatum,
  > extends Force<NodeDatum, never> {
    radius(radius: number | ((node: NodeDatum) => number)): this;
    strength(strength: number | ((node: NodeDatum) => number)): this;
  }

  export function forceRadial<NodeDatum extends SimulationNodeDatum>(
    radius: number | ((node: NodeDatum) => number),
    x?: number,
    y?: number,
    z?: number,
  ): ForceRadial<NodeDatum>;

  /** Per-axis positioning force (forceX / forceY / forceZ). */
  export interface ForcePosition<
    NodeDatum extends SimulationNodeDatum,
  > extends Force<NodeDatum, never> {
    strength(strength: number | ((node: NodeDatum) => number)): this;
  }

  export function forceX<NodeDatum extends SimulationNodeDatum>(
    x?: number | ((node: NodeDatum) => number),
  ): ForcePosition<NodeDatum>;

  export function forceY<NodeDatum extends SimulationNodeDatum>(
    y?: number | ((node: NodeDatum) => number),
  ): ForcePosition<NodeDatum>;

  export function forceZ<NodeDatum extends SimulationNodeDatum>(
    z?: number | ((node: NodeDatum) => number),
  ): ForcePosition<NodeDatum>;
}
