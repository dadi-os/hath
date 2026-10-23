/** Immutable kebab-case agent ids (primary key and address). */

import { z } from "zod";

/** Lowercase kebab-case: `browser-manager`, `browser-worker-cse-431`. */
export const AGENT_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const agentIdSchema = z
  .string()
  .regex(
    AGENT_ID_PATTERN,
    "agent id must be immutable kebab-case (e.g. browser-manager); Ankur is null, not an id",
  );

/** Nullable recipient: agent id or null for the user. */
export const agentIdOrUserSchema = agentIdSchema.nullable();
