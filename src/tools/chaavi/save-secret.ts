import { z } from "zod";
import { defineTool } from "../types.js";
import { chaaviToolCall } from "./call.js";

const input = z
  .object({
    name: z.string().min(1).max(200),
    value: z.string().min(1).max(10000),
    notes: z.string().max(10000).optional(),
  })
  .strict();

/**
 * Save an agent secret as the hidden `Secret` field of the Secure Note named for it, creating
 * the note or replacing its value. The value never appears in the result.
 */
export const saveSecret = defineTool({
  name: "chaavi_save_secret",
  description:
    "Save a secret you obtained or generated (an API key, an app password, a token) to Chaavi so it is never lost and never has to be typed again: it goes in the hidden field Secret of a Secure Note with this name, created if no note has the name, else its value is replaced and its other fields kept. Name it for what it is (\"Gmail app password\", \"Stripe API key\"); later chaavi_fill_secret fills it by that name. notes is optional context for Ankur (what it is for, where it was issued), never the secret itself. For a site username and password use chaavi_create_login instead.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "value"],
    properties: {
      name: { type: "string", description: "Secure Note name, e.g. \"Gmail app password\"" },
      value: { type: "string", description: "The secret value" },
      notes: { type: "string", description: "What it is for and where it came from; not the secret" },
    },
  },
  async handler(ctx, parsed) {
    return chaaviToolCall(
      () => ctx.chaavi.saveSecret(parsed.name, {
        value: parsed.value,
        ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      }),
      (saved) => ({ saved: true, id: saved.item.id, name: saved.item.name, created: saved.created }),
    );
  },
});
