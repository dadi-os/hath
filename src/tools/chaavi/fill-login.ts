import { z } from "zod";
import { HathError } from "../../errors.js";
import { fail, ok } from "../shared.js";
import { defineTool } from "../types.js";
import { fillHidden } from "./call.js";

const input = z
  .object({
    item_id: z.string().min(1),
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    username_ref: z.string().min(1).optional(),
    password_ref: z.string().min(1).optional(),
    submit: z.boolean().optional(),
  })
  .strict();

/**
 * Fill a Chaavi login into a Nas browser. The password never appears in tool content or audit.
 * A sign-in that asks for the username on its own page takes two calls: username_ref alone
 * (with submit to press Enter on it), then password_ref on the next page.
 */
export const fillLogin = defineTool({
  name: "chaavi_fill_login",
  description:
    "Fill a login from Chaavi into a Nas browser. Do not use browser_type for passwords or usernames. Give username_ref, password_ref, or both; a login with no username fills only the password and says so. A site that asks for the username on its own page (an email field and Next, no password field) takes two calls: username_ref alone with submit true, then password_ref on the next page. submit presses Enter after the last field filled. For passkeys use chaavi_fill_passkey. For a new account, chaavi_create_login first.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["item_id", "browser_id"],
    properties: {
      item_id: { type: "string", description: "Vault item id from chaavi_list_items or chaavi_create_login" },
      browser_id: { type: "number", description: "Nas browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
      username_ref: {
        type: "string",
        description: "Accessibility ref of the username field; omit if none",
      },
      password_ref: { type: "string", description: "Accessibility ref of the password field; omit on a username-only page" },
      submit: { type: "boolean", description: "Press Enter after the last field filled" },
    },
  },
  async handler(ctx, parsed) {
    if (parsed.username_ref === undefined && parsed.password_ref === undefined) {
      return fail("give username_ref, password_ref, or both");
    }
    try {
      const login = await ctx.chaavi.getLogin(parsed.item_id);
      if (parsed.username_ref !== undefined && login.username === null && parsed.password_ref === undefined) {
        return fail(`invalid_request: login ${parsed.item_id} has no username to fill`);
      }
      const fillUsername = parsed.username_ref !== undefined && login.username !== null;
      if (parsed.username_ref !== undefined && login.username !== null) {
        await ctx.browsers.type(
          parsed.browser_id,
          parsed.tab_id,
          parsed.username_ref,
          login.username,
          parsed.password_ref === undefined ? parsed.submit : undefined,
        );
      }
      if (parsed.password_ref !== undefined) {
        const passwordRef = parsed.password_ref;
        await fillHidden(
          () => ctx.browsers.type(parsed.browser_id, parsed.tab_id, passwordRef, login.password, parsed.submit),
          "password",
          passwordRef,
          [login.password],
        );
      }
      return ok(
        {
          filled: true,
          item_id: parsed.item_id,
          username: login.username,
          ...(parsed.username_ref !== undefined && !fillUsername ? { username_skipped: "the login has no username" } : {}),
          browser_id: parsed.browser_id,
        },
        {
          item_id: parsed.item_id,
          browser_id: parsed.browser_id,
          ...(parsed.tab_id !== undefined ? { tab_id: parsed.tab_id } : {}),
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
