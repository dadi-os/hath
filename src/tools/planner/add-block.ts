import { z } from "zod";
import { defineTool } from "../types.js";
import { yaadToolCall } from "../yaad/call.js";
import { blockFields, blockProperties } from "./block.js";
import { plannerSource } from "./source.js";

const input = z.object(blockFields).strict();

/** Add one planner block. */
export const plannerAddBlock = defineTool({
  name: "planner_add_block",
  description:
    "Add one block to Ankur's planner, for a single new event on an existing day (a whole day or week goes through planner_replace_range). An overlap with another block is refused with the pair named unless overlap_ok is true. Returns the block with its id.",
  input,
  inputSchema: {
    type: "object",
    properties: blockProperties,
    required: ["start_at", "end_at", "title", "kind", "icon"],
  },
  async handler(ctx, parsed) {
    return yaadToolCall(
      () => ctx.yaad.plannerCreate({ source: plannerSource(ctx), ...parsed }),
      (body) => body,
    );
  },
});
