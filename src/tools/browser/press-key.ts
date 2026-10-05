import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    key: z.string().min(1),
    ref: z.string().min(1).optional(),
  })
  .strict();

/** Press a key or chord, on a ref or on whatever has focus. Intended for workers. */
export const pressKey = defineTool({
  name: "browser_press_key",
  description:
    "Press a key or chord in Playwright key syntax (Enter, Escape, Tab, ArrowDown, Control+Enter, or a single character such as l). With ref, the element from the latest browser_accessibility_tree is focused first; without it, the key goes to whatever has focus. Use it for keyboard shortcuts, closing overlays with Escape, and sending from editors that submit on a chord.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id", "key"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
      key: { type: "string", description: "Key or chord, e.g. Escape or Control+Enter" },
      ref: { type: "string", description: "Optional ref to focus before pressing, e.g. e3" },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      () => ctx.browsers.pressKey(parsed.browser_id, parsed.tab_id, parsed.key, parsed.ref),
      () => ({ pressed: parsed.key, ref: parsed.ref ?? null }),
      (response) => ({ browser_id: parsed.browser_id, tab_id: response.tab_id }),
    );
  },
});
