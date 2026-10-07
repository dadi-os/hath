import { z } from "zod";
import { defineTool } from "../types.js";
import { browserToolCall, pageState } from "./call.js";

const input = z
  .object({
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    scope: z.enum(["page", "display"]),
    full_page: z.boolean().optional(),
  })
  .strict();

/**
 * Screenshot then describe via Dwar. Intended for workers.
 * Prefer accessibility_tree for normal UI; use this for canvas/captcha/visual checks.
 */
export const screenshot = defineTool({
  name: "browser_screenshot",
  description:
    "Capture a PNG and return a Dwar image description (pixels never enter the transcript). scope=page screenshots the tab via Playwright; scope=display captures the whole virtual monitor via Nas (popups, download bars). Prefer browser_accessibility_tree for structured UI work — reach for a screenshot for canvas, captchas, and visual verification, and whenever the accessibility tree fails or is missing the content you need on a JS-rendered page.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["browser_id", "scope"],
    properties: {
      browser_id: { type: "number", description: "Browser id" },
      tab_id: { type: "string", description: "Optional CDP target id (page scope)" },
      scope: {
        type: "string",
        enum: ["page", "display"],
        description: "page = tab screenshot; display = full virtual monitor",
      },
      full_page: {
        type: "boolean",
        description: "For scope=page, capture the full scrollable page",
      },
    },
  },
  async handler(ctx, parsed) {
    return browserToolCall(
      async () => {
        let png: Buffer;
        let tabId = parsed.tab_id;
        let url: string | undefined;
        if (parsed.scope === "display") {
          png = await ctx.nas.browserScreenshot(parsed.browser_id);
        } else {
          const shot = await ctx.browsers.pageScreenshot(
            parsed.browser_id,
            parsed.tab_id,
            parsed.full_page,
          );
          png = shot.png;
          tabId = shot.tab_id;
          url = shot.url;
        }
        const data = png.toString("base64");
        const { description } = await ctx.dwar.describeImage(
          {
            image: { media_type: "image/png", data },
            prompt:
              "Describe this browser screenshot for an agent that cannot see pixels. Note visible text, controls, dialogs, and anything unusual. Start directly with what is on screen — no preamble about the request, the user, or what they want.",
          },
          `hath/${ctx.callerId ?? ctx.callerKind}`,
        );
        return {
          description: description.trim(),
          scope: parsed.scope,
          url,
          tab_id: tabId,
          image: { media_type: "image/png" as const, data },
        };
      },
      (response) => ({
        description: response.description,
        scope: response.scope,
        ...(response.url !== undefined ? { url: response.url } : {}),
      }),
      (response) => ({
        browser_id: parsed.browser_id,
        ...(response.tab_id !== undefined ? { tab_id: response.tab_id } : {}),
        image: response.image,
      }),
      (response) => {
        const where = response.scope === "display" ? "display" : response.tab_id;
        return where === undefined ? undefined : pageState(parsed.browser_id, "screenshot", where);
      },
    );
  },
});
