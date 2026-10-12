import { z } from "zod";
import { chaaviToolCall } from "./call.js";
import { listedItem } from "./list-items.js";
import { defineTool } from "../types.js";

const input = z
  .object({
    name: z.string().min(1).max(200),
    username: z.string().min(1).max(320),
    uri: z.string().min(1).max(2000).optional(),
    password: z.string().min(1).max(500).optional(),
    length: z.number().int().min(12).max(64).optional(),
    special: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.password === undefined || (body.length === undefined && body.special === undefined), {
    message: "length and special apply only when password is omitted",
  });

/**
 * Create a Chaavi login, with a generated password unless the agent was given one. The
 * password never appears in tool content.
 */
export const createLogin = defineTool({
  name: "chaavi_create_login",
  description:
    "Save a new Chaavi login. Omit password and Chaavi generates one that never appears in the result: use that for new site accounts (job applications, signups), then chaavi_fill_login to type username and password into the form. Give password only to save credentials you were handed or a site issued, so they are not lost. Do not invent or browser_type passwords. length defaults to 20 (12–64) and special to true, for a generated password only. uri is the site URL.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "username"],
    properties: {
      name: { type: "string", description: "Vault item name, e.g. the company or site" },
      username: { type: "string", description: "Username or email for the account" },
      uri: { type: "string", description: "Site URL to attach to the login" },
      password: {
        type: "string",
        description: "A password you were given or a site issued; omit to generate one",
      },
      length: {
        type: "number",
        description: "Generated password length, 12–64 (default 20)",
      },
      special: {
        type: "boolean",
        description: "Include !@#$%^&* in the generated password (default true)",
      },
    },
  },
  async handler(ctx, parsed) {
    const input = {
      name: parsed.name,
      username: parsed.username,
      ...(parsed.uri !== undefined ? { uri: parsed.uri } : {}),
      ...(parsed.password !== undefined ? { password: parsed.password } : {}),
      ...(parsed.length !== undefined ? { length: parsed.length } : {}),
      ...(parsed.special !== undefined ? { special: parsed.special } : {}),
    };
    return chaaviToolCall(
      () => ctx.chaavi.createLogin(input),
      listedItem,
    );
  },
});
