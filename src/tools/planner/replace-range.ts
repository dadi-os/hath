import { z } from "zod";
import { defineTool } from "../types.js";
import { yaadToolCall } from "../yaad/call.js";
import { blockInput, blockProperties } from "./block.js";
import { plannerSource } from "./source.js";

const input = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    blocks: z.array(blockInput),
  })
  .strict();

/** Write the caller's whole plan for a time range in one call. */
export const plannerReplaceRange = defineTool({
  name: "planner_replace_range",
  description:
    "Write your whole plan for [from, to) in one call: every block you wrote that starts in the range is deleted and `blocks` written in its place, all or nothing, and what others or Ankur added stays. Every new block must start inside the range. Blocks may not overlap unless overlap_ok is true: an overlap is refused with the clashing pair named, nothing changes, and you fix the times and call again. Build a day or a whole week with one call. Returns every block in the range.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "ISO 8601 with offset; usually the start of a day, or today onward" },
      to: { type: "string", description: "ISO 8601 with offset" },
      blocks: {
        type: "array",
        items: { type: "object", properties: blockProperties, required: ["start_at", "end_at", "title", "kind", "icon"], additionalProperties: false },
      },
    },
    required: ["from", "to", "blocks"],
  },
  async handler(ctx, parsed) {
    return yaadToolCall(
      () => ctx.yaad.plannerReplace({ source: plannerSource(ctx), ...parsed }),
      (body) => body,
    );
  },
});
