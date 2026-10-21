import { z } from "zod";
import { defineTool } from "../types.js";
import { yaadToolCall } from "../yaad/call.js";

const input = z.object({ block_id: z.string().uuid() }).strict();

/** Delete one planner block. */
export const plannerDeleteBlock = defineTool({
  name: "planner_delete_block",
  description:
    "Delete one planner block by id. Use it to remove a single event; to rewrite a day or week, call planner_replace_range instead.",
  input,
  inputSchema: {
    type: "object",
    properties: { block_id: { type: "string", format: "uuid" } },
    required: ["block_id"],
  },
  async handler(ctx, parsed) {
    return yaadToolCall(
      () => ctx.yaad.plannerDelete(parsed.block_id),
      (body) => body,
    );
  },
});
