/** Immutable kebab-case agent ids (primary key and address). */

import { z } from "zod";

/** Lowercase kebab-case: `finance-specialist`, `thread-new-york`. */
export const AGENT_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const agentIdSchema = z
  .string()
  .regex(
    AGENT_ID_PATTERN,
    "agent id must be immutable kebab-case (e.g. finance-specialist); Ankur is null, not an id",
  );
