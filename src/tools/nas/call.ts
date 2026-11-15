import { HathError } from "../../errors.js";
import type { ToolExecResult } from "../shared.js";
import { ok } from "../shared.js";

/**
 * Run a Nas client call; map every Nas failure to a tool error so the run stays alive.
 * Include the error type in the content so not_found / busy / forbidden stay distinguishable.
 */
export async function nasToolCall<T>(
  fn: () => Promise<T>,
  shape: (data: T) => unknown,
  audit: Record<string, unknown> | ((data: T) => Record<string, unknown>) = {},
): Promise<ToolExecResult> {
  try {
    const data = await fn();
    const fields = typeof audit === "function" ? audit(data) : audit;
    return ok(shape(data), fields);
  } catch (err) {
    if (err instanceof HathError) {
      const fields = typeof audit === "function" ? {} : audit;
      return { content: `${err.type}: ${err.message}`, isError: true, audit: fields };
    }
    throw err;
  }
}
