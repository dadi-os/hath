import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    terminal_id: z.string().min(1),
    command: z.string().min(1),
    timeout_seconds: z.number().int().positive().max(3600).optional(),
    max_bytes: z.number().int().positive().optional(),
  })
  .strict();

/** Run a command in a host terminal via Nas exec. Intended for workers. */
export const executeShell = defineTool({
  name: "terminal_execute_shell",
  description:
    "Run a shell command in an existing host terminal and wait for it to finish (or time out). The command runs in a subshell started from the terminal's working directory: cd, export, and set do not carry over to the next call, and nothing the command does (set -e, exit, exec) can end the terminal. Returns exit_code, output, truncated, and timed_out. If timed_out is true the command is still running — use terminal_read to see more output and terminal_send_keys (e.g. [\"C-c\"]) to interrupt. Do not use this tool to read, edit or search files; use terminal_read_file, terminal_edit_file and terminal_write_file, and terminal_grep and terminal_glob instead of grep, find or ls. Git, package managers, and process control all go through this tool.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["terminal_id", "command"],
    properties: {
      terminal_id: { type: "string", description: "Terminal id handed off by the manager" },
      command: { type: "string", description: "Shell command to run" },
      timeout_seconds: {
        type: "number",
        description: "Seconds to wait before returning timed_out (default 120, max 3600)",
      },
      max_bytes: {
        type: "number",
        description: "Max output bytes; excess is head+tail truncated (default 32768)",
      },
    },
  },
  async handler(ctx, parsed) {
    const body = {
      command: parsed.command,
      ...(parsed.timeout_seconds !== undefined
        ? { timeout_seconds: parsed.timeout_seconds }
        : {}),
      ...(parsed.max_bytes !== undefined ? { max_bytes: parsed.max_bytes } : {}),
    };
    return nasToolCall(
      () => ctx.nas.exec(parsed.terminal_id, body),
      (response) => response,
      { terminal_id: parsed.terminal_id },
    );
  },
});
