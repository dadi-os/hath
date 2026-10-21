import { z } from "zod";
import { defineTool } from "../types.js";
import { yaadToolCall } from "../yaad/call.js";

const input = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .strict();

/** Read the planner blocks overlapping a time range. */
export const plannerListRange = defineTool({
  name: "planner_list_range",
  description:
    "List Ankur's planner blocks overlapping [from, to), earliest first, with id, times, title, note, kind, icon, fixed, overlap_ok, done_at and the source that wrote each. Use it to answer what is on a day and to see what exists before changing it.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "ISO 8601 with offset" },
      to: { type: "string", description: "ISO 8601 with offset" },
    },
    required: ["from", "to"],
  },
  async handler(ctx, parsed) {
    return yaadToolCall(
      () => ctx.yaad.plannerQuery(parsed),
      (body) => body,
    );
  },
});
