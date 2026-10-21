import { z } from "zod";
import { defineTool } from "../types.js";
import { chaaviToolCall } from "./call.js";

const input = z.object({}).strict();

/** List the vault's folders via Chaavi `GET /v1/folders`. */
export const listFolders = defineTool({
  name: "chaavi_list_folders",
  description:
    "List the vault's folders by full name, in name order. A slash nests a folder under another (development/fliks-gg is inside development), and a parent may exist only as the start of its children's names. Pass a name to chaavi_list_items as folder to list that folder and everything nested under it.",
  input,
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  async handler(ctx) {
    return chaaviToolCall(
      () => ctx.chaavi.listFolders(),
      (response) => ({ folders: response.folders.map((folder) => folder.name).sort((a, b) => a.localeCompare(b)) }),
    );
  },
});
