import { z } from "zod";
import { HathError } from "../../errors.js";
import { fail, ok } from "../shared.js";
import { defineTool } from "../types.js";

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
 * typeSecret fills `secret` at `ref`. A failure reports only the first line of the driver's
 * error with the secret scrubbed: Playwright's call log for a fill can carry the value.
 */
async function typeSecret(
  browsers: { type: (browserId: number, tabId: string | undefined, ref: string, text: string, submit?: boolean) => Promise<unknown> },
  browserId: number,
  tabId: string | undefined,
  ref: string,
  secret: string,
  submit: boolean | undefined,
): Promise<void> {
  try {
    await browsers.type(browserId, tabId, ref, secret, submit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const firstLine = message.split("\n")[0]!.split(secret).join("[password]");
    throw new HathError(422, "browser", `password field ${ref} was not filled: ${firstLine}`);
  }
}

/**
 * Fill a Chaavi login into a Nas browser. The password never appears in tool content or audit.
 * A sign-in that asks for the username on its own page takes two calls: username_ref alone
 * (with submit to press Enter on it), then password_ref on the next page.
 */
export const fillLogin = defineTool({
  name: "chaavi_fill_login",
  description:
    "Fill a login from Chaavi into a Nas browser. Do not use browser_type for passwords or usernames. Give username_ref, password_ref, or both. A site that asks for the username on its own page (an email field and Next, no password field) takes two calls: username_ref alone with submit true, then password_ref on the next page. submit presses Enter after the last field filled. For passkeys use chaavi_fill_passkey. For a new account, chaavi_create_login first.",
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
      if (parsed.username_ref !== undefined) {
        await ctx.browsers.type(
          parsed.browser_id,
          parsed.tab_id,
          parsed.username_ref,
          login.username,
          parsed.password_ref === undefined ? parsed.submit : undefined,
        );
      }
      if (parsed.password_ref !== undefined) {
        await typeSecret(
          ctx.browsers,
          parsed.browser_id,
          parsed.tab_id,
          parsed.password_ref,
          login.password,
          parsed.submit,
        );
      }
      return ok(
        {
          filled: true,
          item_id: parsed.item_id,
          username: login.username,
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
