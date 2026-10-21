import type { ToolContext } from "../shared.js";

/** The writer a planner block records: the calling agent, or "manual" for a person at the CLI. */
export function plannerSource(ctx: ToolContext): string {
  return ctx.callerKind === "agent" && ctx.callerId !== null ? ctx.callerId : "manual";
}
