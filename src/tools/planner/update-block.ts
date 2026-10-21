import { z } from "zod";
import { defineTool } from "../types.js";
import { yaadToolCall } from "../yaad/call.js";
import { blockFields, blockProperties } from "./block.js";

const input = z
  .object({ block_id: z.string().uuid(), ...blockFields })
  .partial({ start_at: true, end_at: true, title: true, kind: true, icon: true })
  .strict();

/** Change fields of one planner block. */
export const plannerUpdateBlock = defineTool({
  name: "planner_update_block",
  description:
    "Change one planner block by id: send only the fields that change (move it with start_at and end_at, retitle, edit the note, change its kind or icon). A change that would overlap another block is refused with the pair named. Returns the block.",
  input,
  inputSchema: {
    type: "object",
    properties: { block_id: { type: "string", format: "uuid" }, ...blockProperties },
    required: ["block_id"],
  },
  async handler(ctx, parsed) {
    const { block_id: id, ...fields } = parsed;
    return yaadToolCall(
      () => ctx.yaad.plannerUpdate(id, fields),
      (body) => body,
    );
  },
});
