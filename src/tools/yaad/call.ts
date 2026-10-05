import { HathError } from "../../errors.js";
import type { ToolExecResult } from "../shared.js";
import { fail, ok } from "../shared.js";

/** Run a Yaad client call; map every Yaad failure to a tool error so the lane stays alive. */
export async function yaadToolCall<T>(
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
