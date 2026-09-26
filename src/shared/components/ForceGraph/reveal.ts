/** When and from where one node enters during the opening bloom. */
export type RevealStep = {
  /** Seconds after the bloom starts. */
  delay: number;
  /** Earlier node it sprouts from along their link, or null to grow in place. */
  anchor: string | null;
};

/** Seconds between successive waves (seeds, their neighbors, the next ring, …). */
const WAVE_GAP = 0.34;
/** Longest a single wave's stagger may take, however many nodes it holds. */
const WAVE_SPREAD = 0.45;
/** Stagger between nodes of a wave until `WAVE_SPREAD` caps it. */
const STAGGER = 0.05;

/**
 * Opening bloom order for a graph. `seeds` appear first in place (most-connected
 * first); each following wave is the next ring of neighbors, each sprouting from the
 * earlier node that reached it. Nodes not connected to any seed bloom in place in a
 * final wave. Iteration order of the result is reveal order, so an anchor always
 * precedes the nodes that sprout from it.
 */
export function revealSchedule(
  nodes: Array<{ id: string; degree: number }>,
  links: Array<{ source: { id: string }; target: { id: string } }>,
  seeds: Set<string>,
): Map<string, RevealStep> {
  const degree = new Map(nodes.map((n) => [n.id, n.degree]));
  const neighbors = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const l of links) {
    neighbors.get(l.source.id)?.push(l.target.id);
    neighbors.get(l.target.id)?.push(l.source.id);
  }
  const byDegree = (a: { id: string }, b: { id: string }) =>
    (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id);

  const schedule = new Map<string, RevealStep>();
  let wave: Array<{ id: string; anchor: string | null }> = nodes
    .filter((n) => seeds.has(n.id))
    .sort(byDegree)
    .map((n) => ({ id: n.id, anchor: null }));
  if (wave.length === 0 && nodes.length > 0) {
    wave = [{ id: [...nodes].sort(byDegree)[0]!.id, anchor: null }];
  }

  let index = 0;
  while (wave.length > 0) {
    const step = Math.min(STAGGER, WAVE_SPREAD / Math.max(wave.length - 1, 1));
    wave.forEach((entry, j) => {
      schedule.set(entry.id, { delay: index * WAVE_GAP + j * step, anchor: entry.anchor });
    });

    const next = new Map<string, string>();
    for (const entry of wave) {
      for (const nb of neighbors.get(entry.id) ?? []) {
        if (!schedule.has(nb) && !next.has(nb)) {
          next.set(nb, entry.id);
        }
      }
    }
    wave = [...next]
      .map(([id, anchor]) => ({ id, anchor }))
      .sort(byDegree);
    if (wave.length === 0 && schedule.size < nodes.length) {
      wave = nodes
        .filter((n) => !schedule.has(n.id))
        .sort(byDegree)
        .map((n) => ({ id: n.id, anchor: null }));
    }
    index += 1;
  }
  return schedule;
}
