import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall, pageState } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    max_bytes: z.number().int().positive().optional(),
  })
  .strict();

/** Visible page text. Intended for workers. */
export const extractText = defineTool({
  name: "browser_extract_text",
  description: "Return the visible inner text of the page, bounded by max_bytes. Use for read-heavy pages where an accessibility snapshot is mostly noise.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
      max_bytes: { type: "number", description: "Max UTF-8 bytes (default from config)" },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      () => ctx.browsers.extractText(parsed.browser_id, parsed.tab_id, parsed.max_bytes),
      (response) => `url: ${response.url}\ntruncated: ${response.truncated}\n${response.text}`,
      (response) => ({ browser_id: parsed.browser_id, tab_id: response.tab_id }),
      (response) => pageState(parsed.browser_id, "text", response.url),
    );
  },
});
