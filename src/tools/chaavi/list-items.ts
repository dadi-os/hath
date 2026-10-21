import { z } from "zod";
import type { ChaaviItem } from "../../chaavi/client.js";
import { defineTool } from "../types.js";
import { chaaviToolCall } from "./call.js";

const ITEM_TYPES = ["login", "note", "card", "identity", "sshKey", "bankAccount", "driversLicense", "passport"] as const;

const input = z
  .object({
    q: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
    type: z.enum(ITEM_TYPES).optional(),
    folder: z.string().min(1).optional(),
  })
  .strict();

/**
 * listedItem is what an agent sees of a vault item: what it is and how to use it, never a
 * value. A login shows its username, sites and whether it has a passkey; a card only its
 * brand; a Secure Note whether it holds a hidden `Secret` (an agent secret). With
 * `folderNames` (folder id to full folder name) it also names the item's folder, null when
 * it has none.
 */
export function listedItem(item: ChaaviItem, folderNames?: Map<string, string>): Record<string, unknown> {
  const base = {
    id: item.id,
    name: item.name,
    type: item.type,
    ...(folderNames !== undefined ? { folder: (item.folderId !== null && folderNames.get(item.folderId)) || null } : {}),
  };
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
    "Find vault items by name, site uri or folder: logins (with hasPasskey), Secure Notes (secret true when the note holds a secret for chaavi_fill_secret), cards, identities, SSH keys, bank accounts, driver's licenses and passports. Never returns a password, card number or other secret value. Each item names its folder; folders nest with a slash (development/fliks-gg), and folder takes the folder and every folder nested under it, so one Google account's items can be listed alone. Call this before chaavi_fill_login, chaavi_fill_passkey, chaavi_fill_card or chaavi_read_note when you do not already have the item_id. For a new site account use chaavi_create_login.",
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
      folder: {
        type: "string",
        description: "A folder name from chaavi_list_folders, e.g. development; includes the folders nested under it. An unknown folder is an error.",
      },
    },
  },
  async handler(ctx, parsed) {
    const query = {
      ...(parsed.q !== undefined ? { q: parsed.q } : {}),
      ...(parsed.uri !== undefined ? { uri: parsed.uri } : {}),
      ...(parsed.type !== undefined ? { type: parsed.type } : {}),
      ...(parsed.folder !== undefined ? { folder: parsed.folder } : {}),
    };
    return chaaviToolCall(
      async () => {
        const [{ items }, { folders }] = await Promise.all([ctx.chaavi.listItems(query), ctx.chaavi.listFolders()]);
        const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]));
        return { items: items.map((item) => listedItem(item, folderNames)) };
      },
      (response) => response,
    );
  },
});
