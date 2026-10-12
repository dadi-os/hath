import { z } from "zod";
import type { ChaaviItem } from "../../chaavi/client.js";
import { defineTool } from "../types.js";
import { chaaviToolCall } from "./call.js";

const ITEM_TYPES = ["login", "note", "card", "identity", "sshKey"] as const;

const input = z
  .object({
    q: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
    type: z.enum(ITEM_TYPES).optional(),
  })
  .strict();

/**
 * listedItem is what an agent sees of a vault item: what it is and how to use it, never a
 * value. A login shows its username, sites and whether it has a passkey; a card only its
 * brand; a Secure Note whether it holds a hidden `Secret` (an agent secret).
 */
export function listedItem(item: ChaaviItem): Record<string, unknown> {
  const base = { id: item.id, name: item.name, type: item.type };
  if (item.type === "login" && item.login !== undefined) {
    return {
      ...base,
      username: item.login.username,
      uris: item.login.uris.map((entry) => entry.uri),
      hasPasskey: item.login.passkeys.length > 0,
    };
  }
  if (item.type === "card" && item.card !== undefined) {
    return { ...base, brand: item.card.brand };
  }
  if (item.type === "note") {
    return { ...base, secret: item.fields.some((field) => field.name === "Secret" && field.type === "hidden") };
  }
  return base;
}

/** Find vault items (metadata only) via Chaavi `GET /v1/items`. */
export const listItems = defineTool({
  name: "chaavi_list_items",
  description:
    "Find vault items by name or site uri: logins (with hasPasskey), Secure Notes (secret true when the note holds a secret for chaavi_fill_secret), cards, identities and SSH keys. Never returns a password, card number or other secret value. Call this before chaavi_fill_login, chaavi_fill_passkey, chaavi_fill_card or chaavi_read_note when you do not already have the item_id. For a new site account use chaavi_create_login.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      q: { type: "string", description: "Search name, username, site, card brand or identity name" },
      uri: { type: "string", description: "Site uri filter" },
      type: {
        type: "string",
        enum: [...ITEM_TYPES],
        description: "Only items of this type",
      },
    },
  },
  async handler(ctx, parsed) {
    const query = {
      ...(parsed.q !== undefined ? { q: parsed.q } : {}),
      ...(parsed.uri !== undefined ? { uri: parsed.uri } : {}),
      ...(parsed.type !== undefined ? { type: parsed.type } : {}),
    };
    return chaaviToolCall(
      () => ctx.chaavi.listItems(query),
      (response) => ({ items: response.items.map(listedItem) }),
    );
  },
});
