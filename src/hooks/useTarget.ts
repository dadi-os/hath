import { HATH_TARGET, type HathTarget } from "../target";

/** Current build target. Stable for the life of the process. */
export function useTarget(): HathTarget {
  return HATH_TARGET;
}
