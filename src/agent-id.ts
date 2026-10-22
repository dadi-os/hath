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

/**
 * Nullable recipient: agent id or null for the user. A model that writes the user's name
 * ("Ankur", "user") where null belongs means the user, so those read as null; every other
 * string must still be an agent id.
 */
export const agentIdOrUserSchema = z.preprocess(
  (value) => (typeof value === "string" && /^(ankur|user)$/i.test(value.trim()) ? null : value),
  agentIdSchema.nullable(),
);
