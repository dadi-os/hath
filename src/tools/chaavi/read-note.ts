import { z } from "zod";
import { HathError } from "../../errors.js";
import { fail, ok } from "../shared.js";
import { defineTool } from "../types.js";

const input = z
  .object({
    item_id: z.string().min(1),
  })
  .strict();

/** Read a Secure Note's text and its non-hidden custom fields; hidden fields are named only. */
export const readNote = defineTool({
  name: "chaavi_read_note",
  description:
    "Read a Chaavi Secure Note: its text and its text, boolean and linked fields. Hidden fields are listed by name only, never their values; fill a note's Secret with chaavi_fill_secret. Find the item_id with chaavi_list_items (type note).",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["item_id"],
    properties: {
      item_id: { type: "string", description: "Secure Note id from chaavi_list_items" },
    },
  },
  async handler(ctx, parsed) {
    try {
      const item = await ctx.chaavi.getItem(parsed.item_id);
      if (item.type !== "note") {
        return fail(`invalid_request: item ${parsed.item_id} is a ${item.type}, not a secure note`);
      }
      const notes = item.hasNotes ? (await ctx.chaavi.reveal(item.id, { field: "notes" })).value : "";
      return ok({
        id: item.id,
        name: item.name,
        notes,
        fields: item.fields.flatMap((field): Array<Record<string, unknown>> => {
          if (field.type === "hidden") {
            return [];
          }
          if (field.type === "linked") {
            return [{ name: field.name, type: field.type, linked_to: field.linkedTo }];
          }
          return [{ name: field.name, type: field.type, value: field.value }];
        }),
        hidden_fields: item.fields.filter((field) => field.type === "hidden").map((field) => field.name),
      });
    } catch (err) {
      if (err instanceof HathError) {
        return fail(`${err.type}: ${err.message}`);
      }
      throw err;
    }
  },
});
