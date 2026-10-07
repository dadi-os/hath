import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall, pageReadInput, pageReadProperty, readPage } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    ref: z.string().min(1),
    read: pageReadInput.optional(),
  })
  .strict();

/** Click by snapshot ref. Intended for workers. */
export const click = defineTool({
  name: "browser_click",
  description:
    "Click the element with the given ref from the latest browser_accessibility_tree. Fails with stale_ref if the ref is missing or ambiguous — take a fresh snapshot. With read, it waits for the page to settle after the click (for a navigation it starts, until that page loads) and returns the page as well, so the next step does not need its own browser_accessibility_tree or browser_extract_text call; a tree read this way replaces the earlier refs.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id", "ref"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
      ref: { type: "string", description: "Ref from accessibility_tree, e.g. e3" },
      read: pageReadProperty,
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      async () => {
        const read = parsed.read;
        const clicked = await ctx.browsers.click(
          parsed.browser_id,
          parsed.tab_id,
          parsed.ref,
          read !== undefined,
        );
        const page =
          read === undefined
            ? null
            : await readPage(ctx, parsed.browser_id, clicked.tab_id, read, `clicked ${parsed.ref}`);
        return { tab_id: clicked.tab_id, page };
      },
      (response) =>
        response.page === null
          ? { clicked: true as const, ref: parsed.ref }
          : `clicked: ${parsed.ref}\n${response.page}`,
      (response) => ({ browser_id: parsed.browser_id, tab_id: response.tab_id }),
    );
  },
});
