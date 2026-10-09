import { z } from "zod";
import { HathError } from "../../errors.js";
import { fail, ok } from "../shared.js";
import { defineTool } from "../types.js";

const input = z
  .object({
    item_id: z.string().min(1),
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
  })
  .strict();

/**
 * Fill a Chaavi passkey into a Nas browser virtual authenticator and reload the tab so the
 * site asks again. The private key never appears in tool content or audit.
 */
export const fillPasskey = defineTool({
  name: "chaavi_fill_passkey",
  description:
    "Load a Chaavi passkey into a Nas browser tab, then reload the tab so the site asks for the passkey again and signs in with it. Call it once on the site's sign-in flow, at any step, including when a passkey, phone or QR prompt is already showing (on Google, the \"Complete sign-in using your passkey\" page). Then read the page: if it signed in, continue; if it shows a passkey button, click it; if the reload cleared something you typed, type it again and continue. No wait, retry or extra reload is needed. The passkey stays loaded on the tab across later steps, and each call replaces the tab's previous one. The key never appears in the result. Use when chaavi_list_items shows hasPasskey. Do not use chaavi_fill_login for passkeys.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["item_id", "browser_id"],
    properties: {
      item_id: { type: "string", description: "Vault item id from chaavi_list_items" },
      browser_id: { type: "number", description: "Nas browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
    },
  },
  async handler(ctx, parsed) {
    try {
      const passkey = await ctx.chaavi.getPasskey(parsed.item_id);
      const injected = await ctx.browsers.addPasskey(parsed.browser_id, parsed.tab_id, passkey);
      return ok(
        {
          filled: true,
          item_id: parsed.item_id,
          rp_id: passkey.rpId,
          browser_id: parsed.browser_id,
          tab_id: injected.tab_id,
          url: injected.url,
        },
        {
          item_id: parsed.item_id,
          rp_id: passkey.rpId,
          browser_id: parsed.browser_id,
          tab_id: injected.tab_id,
        },
      );
    } catch (err) {
      if (err instanceof HathError) {
        return fail(`${err.type}: ${err.message}`);
      }
      throw err;
    }
  },
});
