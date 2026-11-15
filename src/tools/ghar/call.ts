import { HathError } from "../../errors.js";
import type { ToolExecResult } from "../shared.js";
import { fail, ok } from "../shared.js";

/**
 * Run a Ghar client call; map every Ghar failure to a tool error so the run stays alive.
 * Include the error type in the content so capability vs unreachable stay distinguishable.
 */
export async function gharToolCall<T>(
  fn: () => Promise<T>,
  shape: (data: T) => unknown,
): Promise<ToolExecResult> {
  try {
    const data = await fn();
    return ok(shape(data));
  } catch (err) {
    if (err instanceof HathError) {
      return fail(`${err.type}: ${err.message}`);
    }
    throw err;
  }
}
