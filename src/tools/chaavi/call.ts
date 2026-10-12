import { HathError } from "../../errors.js";
import type { ToolExecResult } from "../shared.js";
import { fail, ok } from "../shared.js";

/**
 * Run a Chaavi client call; map every Chaavi failure to a tool error so the lane stays alive.
 * Include the error type in the content so vault_unconfigured vs unreachable stay distinguishable.
 */
export async function chaaviToolCall<T>(
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

/**
 * fillHidden runs a browser fill of a vault value at `ref`. A failure reports only the first
 * line of the driver's error with every given value scrubbed to `[label]`: Playwright's call
 * log for a fill can carry the value.
 */
export async function fillHidden(
  fill: () => Promise<unknown>,
  label: string,
  ref: string,
  values: readonly string[],
): Promise<void> {
  try {
    await fill();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let firstLine = message.split("\n")[0]!;
    for (const value of values) {
      if (value.length > 0) {
        firstLine = firstLine.split(value).join(`[${label}]`);
      }
    }
    throw new HathError(422, "browser", `${label} field ${ref} was not filled: ${firstLine}`);
  }
}
