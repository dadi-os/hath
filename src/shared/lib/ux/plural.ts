/**
 * Singular noun when `count === 1`, otherwise plural.
 * Default plural is `singular` + `s`/`S` matching the singular's case;
 * pass `plural` for MEMORY/MEMORIES, PERSON/PEOPLE, etc.
 */
export function countNoun(
  count: number,
  singular: string,
  plural?: string,
): string {
  if (count === 1) {
    return singular;
  }
  if (plural !== undefined) {
    return plural;
  }
  const suffix = singular === singular.toUpperCase() ? "S" : "s";
  return `${singular}${suffix}`;
}
