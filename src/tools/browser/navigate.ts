import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall, pageReadInput, pageReadProperty, readPage } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    url: z.string().min(1),
    wait_until: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
    read: pageReadInput.optional(),
  })
  .strict();

/** Navigate a tab. Intended for workers. */
export const navigate = defineTool({
  name: "browser_navigate",
  description:
    "Navigate the focused tab (or tab_id) to a URL. Returns the final url and title. When the URL is a file download, also returns download: the suggested file name and the host downloads_dir it is saving into (a taken name gets a numbered suffix, and a large file may still be saving). Pass read to get the loaded page back in the same call — tree for its accessibility tree with refs to act on, text for its visible text — instead of following up with browser_accessibility_tree or browser_extract_text.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id", "url"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      tab_id: { type: "string", description: "Optional CDP target id; defaults to focused tab" },
      url: { type: "string", description: "URL to load" },
      wait_until: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle"],
        description: "Playwright waitUntil (default load)",
      },
      read: pageReadProperty,
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      async () => {
        const navigated = await ctx.browsers.navigate(
          parsed.browser_id,
          parsed.tab_id,
          parsed.url,
          parsed.wait_until ?? "load",
        );
        const page =
          parsed.read === undefined
            ? null
            : await readPage(
                ctx,
                parsed.browser_id,
                navigated.tab_id,
                parsed.read,
                `navigated to ${navigated.url}`,
              );
        return { ...navigated, page };
      },
      (response) => {
        const download = response.download ? { download: response.download } : {};
        if (response.page === null) {
          return { url: response.url, title: response.title, ...download };
        }
        const downloadLine = response.download
          ? `download: ${JSON.stringify(response.download)}\n`
          : "";
        return `title: ${response.title}\n${downloadLine}${response.page}`;
      },
      (response) => ({ browser_id: parsed.browser_id, tab_id: response.tab_id }),
    );
  },
});
