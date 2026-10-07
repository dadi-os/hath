import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    terminal_id: z.string().min(1),
    lines: z.number().int().positive().optional(),
  })
  .strict();

/** Capture terminal pane output via Nas. Intended for workers. */
export const readTerminal = defineTool({
  name: "terminal_read",
  description:
    "Read recent output from a host terminal pane without sending a new command. Use this after terminal_execute_shell times out to see a still-running command's progress.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["terminal_id"],
    properties: {
      terminal_id: { type: "string", description: "Terminal id" },
      lines: {
        type: "number",
        description: "How many history lines to capture (default 200)",
      },
    },
  },
  async handler(ctx, parsed) {
    const query = parsed.lines !== undefined ? { lines: parsed.lines } : {};
    const result = await nasToolCall(
      () => ctx.nas.capture(parsed.terminal_id, query),
      (response) => response,
      { terminal_id: parsed.terminal_id },
    );
    return result.isError ? result : { ...result, state: `terminal:${parsed.terminal_id}` };
  },
});
