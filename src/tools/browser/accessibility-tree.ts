import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    max_bytes: z.number().int().positive().optional(),
  })
  .strict();

/** Accessibility snapshot with refs. Intended for workers. */
export const accessibilityTree = defineTool({
  name: "browser_accessibility_tree",
  description:
    "Take a bounded accessibility/DOM snapshot of the page. Interactive elements get refs like e1, e2 written to data-dadi-ref. Refs stay valid until the next browser_accessibility_tree call, so reuse them for several clicks, types and selects on the same page; snapshot again after the page navigates or redraws, or when an action fails with stale_ref. Prefer this over screenshots for normal UI work. If it fails, comes back empty, or the page is JS-rendered so the tree does not show what you need, fall back to browser_screenshot to see the page before reporting that you are stuck.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
      max_bytes: {
        type: "number",
        description: "Max UTF-8 bytes for the tree (default from config)",
      },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      () => ctx.browsers.accessibilityTree(parsed.browser_id, parsed.tab_id, parsed.max_bytes),
      (response) => `url: ${response.url}\ntruncated: ${response.truncated}\n${response.tree}`,
      (response) => ({ browser_id: parsed.browser_id, tab_id: response.tab_id }),
    );
  },
});
