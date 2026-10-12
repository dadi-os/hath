import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HathError } from "../../errors.js";
import { fail, ok, type ToolContext, type ToolExecResult } from "../shared.js";
import { defineTool } from "../types.js";
import { fillHidden } from "./call.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const input = z
  .object({
    name: z.string().min(1).max(200),
    terminal_id: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    env_name: z.string().min(1).regex(ENV_NAME).optional(),
    timeout_seconds: z.number().int().positive().max(3600).optional(),
    max_bytes: z.number().int().positive().optional(),
    browser_id: z.number().int().positive().optional(),
    tab_id: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    submit: z.boolean().optional(),
  })
  .strict()
  .superRefine((body, issue) => {
    const terminal = body.terminal_id !== undefined || body.command !== undefined || body.env_name !== undefined;
    const browser = body.browser_id !== undefined || body.ref !== undefined;
    if (terminal === browser) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        message: "give terminal_id, command and env_name, or browser_id and ref",
      });
      return;
    }
    if (terminal && (body.terminal_id === undefined || body.command === undefined || body.env_name === undefined)) {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: "a terminal fill needs terminal_id, command and env_name" });
    }
    if (browser && (body.browser_id === undefined || body.ref === undefined)) {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: "a browser fill needs browser_id and ref" });
    }
  });

type FillSecretInput = z.infer<typeof input>;

/**
 * Fill an agent secret into a host terminal command's environment or a Nas browser field.
 * The secret is the hidden `Secret` field of the Secure Note named for it; its value never
 * appears in tool content or audit.
 */
export const fillSecret = defineTool({
  name: "chaavi_fill_secret",
  description:
    "Fill a secret from Chaavi without seeing it. A secret is a Chaavi Secure Note named for it (\"Gmail app password\", \"Stripe API key\") whose value is its hidden field Secret; give that name (case does not matter). Terminal: give terminal_id, command and env_name, and the command runs with the secret in env_name, its output scrubbed of the value. Browser: give browser_id and the field's ref (and submit to press Enter). Use for API keys, app passwords and tokens; site logins use chaavi_fill_login. chaavi_list_items shows secret true on notes that hold one; save a new one with chaavi_save_secret.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", description: "Name of the Secure Note that holds the secret" },
      terminal_id: { type: "string", description: "Terminal id handed off by the manager (terminal fill)" },
      command: { type: "string", description: "Shell command to run with the secret in env (terminal fill)" },
      env_name: {
        type: "string",
        pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
        description: "Environment variable that receives the secret (terminal fill)",
      },
      timeout_seconds: {
        type: "number",
        description: "Seconds to wait before returning timed_out (default 120, max 3600; terminal fill)",
      },
      max_bytes: {
        type: "number",
        description: "Max output bytes; excess is head+tail truncated (default 32768; terminal fill)",
      },
      browser_id: { type: "number", description: "Nas browser id (browser fill)" },
      tab_id: { type: "string", description: "Optional CDP target id (browser fill)" },
      ref: { type: "string", description: "Accessibility ref of the field to fill (browser fill)" },
      submit: { type: "boolean", description: "Press Enter after filling (browser fill)" },
    },
  },
  async handler(ctx, parsed) {
    if (parsed.browser_id !== undefined && parsed.ref !== undefined) {
      return fillBrowser(ctx, parsed, parsed.browser_id, parsed.ref);
    }
    if (parsed.terminal_id !== undefined && parsed.command !== undefined && parsed.env_name !== undefined) {
      return fillTerminal(ctx, parsed, {
        terminalId: parsed.terminal_id,
        command: parsed.command,
        envName: parsed.env_name,
      });
    }
    return fail("give terminal_id, command and env_name, or browser_id and ref");
  },
});

/** Type the secret into one browser field. */
async function fillBrowser(
  ctx: ToolContext,
  parsed: FillSecretInput,
  browserId: number,
  ref: string,
): Promise<ToolExecResult> {
  try {
    const secret = await ctx.chaavi.revealSecret(parsed.name);
    await fillHidden(
      () => ctx.browsers.type(browserId, parsed.tab_id, ref, secret.value, parsed.submit),
      "secret",
      ref,
      [secret.value],
    );
    return ok(
      { filled: true, name: parsed.name, browser_id: browserId, ref },
      { name: parsed.name, browser_id: browserId, ...(parsed.tab_id !== undefined ? { tab_id: parsed.tab_id } : {}) },
    );
  } catch (err) {
    if (err instanceof HathError) {
      return fail(`${err.type}: ${err.message}`);
    }
    throw err;
  }
}

/** Stage the secret to a temp file, load it into env_name, delete the file, then run the command. */
async function fillTerminal(
  ctx: ToolContext,
  parsed: FillSecretInput,
  target: { terminalId: string; command: string; envName: string },
): Promise<ToolExecResult> {
  const { terminalId } = target;
  let stagedPath: string | undefined;
  try {
    const secret = await ctx.chaavi.revealSecret(parsed.name);
    const path = `/tmp/dadi-chaavi-${randomUUID()}`;
    await ctx.nas.writeFile({ path, content: secret.value });
    stagedPath = path;
    const quoted = shellQuote(path);
    const wrapped = `export ${target.envName}=$(cat ${quoted}); rm -f ${quoted}; ${target.command}`;
    const body = {
      command: wrapped,
      ...(parsed.timeout_seconds !== undefined ? { timeout_seconds: parsed.timeout_seconds } : {}),
      ...(parsed.max_bytes !== undefined ? { max_bytes: parsed.max_bytes } : {}),
    };
    const response = await ctx.nas.exec(terminalId, body);
    stagedPath = undefined;
    return ok({
      exit_code: response.exit_code,
      output: response.output.replaceAll(secret.value, "***"),
      truncated: response.truncated,
      timed_out: response.timed_out,
      name: parsed.name,
      env_name: target.envName,
    });
  } catch (err) {
    let leftover = "";
    if (stagedPath !== undefined) {
      try {
        await ctx.nas.exec(terminalId, { command: `rm -f ${shellQuote(stagedPath)}` });
        stagedPath = undefined;
      } catch (cleanupErr) {
        const reason = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        leftover = ` secret staging file may remain at ${stagedPath} (cleanup failed: ${reason}); retry after terminal idle`;
      }
    }
    if (err instanceof HathError) {
      return fail(`${err.type}: ${err.message}${leftover}`);
    }
    throw err;
  }
}

/**
 * shellQuote wraps s in POSIX single quotes, turning each `'` into `'\''`.
 */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
