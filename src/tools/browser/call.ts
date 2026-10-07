import { z } from "zod";
import { HathError } from "../../errors.js";
import type { ToolContext, ToolExecResult } from "../shared.js";
import { ok } from "../shared.js";

/** What an action can read back from the page once done: its accessibility tree or its text. */
export const pageReadInput = z.enum(["tree", "text"]);

/** The JSON schema for an action's optional `read`. */
export const pageReadProperty = {
  type: "string",
  enum: ["tree", "text"],
  description:
    "Also return the page once the action is done, saving a separate call: tree as browser_accessibility_tree returns it (fresh refs), text as browser_extract_text does",
};

/**
 * pageState is the wake state key of a page read (see ToolExecResult.state). A tree or a
 * screenshot stands for its tab (`where` is the tab id, or `display` for the whole monitor):
 * the newer one makes the older stale. Text stands for its page (`where` is the URL), so
 * reading another page never hides text the agent gathered from this one.
 */
export function pageState(
  browserId: number,
  kind: "tree" | "text" | "screenshot",
  where: string,
): string {
  return `browser:${browserId}:${kind}:${where}`;
}

/**
 * readPage returns the page as browser_accessibility_tree ("tree") or browser_extract_text
 * ("text") would, with that read's state key, for an action that has already happened. A
 * failed read names that action (`done`), so the agent does not repeat it.
 */
export async function readPage(
  ctx: ToolContext,
  browserId: number,
  tabId: string,
  read: z.infer<typeof pageReadInput>,
  done: string,
): Promise<{ page: string; state: string }> {
  try {
    if (read === "tree") {
      const snapshot = await ctx.browsers.accessibilityTree(browserId, tabId);
      return {
        page: `url: ${snapshot.url}\ntruncated: ${snapshot.truncated}\n${snapshot.tree}`,
        state: pageState(browserId, "tree", tabId),
      };
    }
    const text = await ctx.browsers.extractText(browserId, tabId);
    return {
      page: `url: ${text.url}\ntruncated: ${text.truncated}\n${text.text}`,
      state: pageState(browserId, "text", text.url),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const message = `${done}, but reading the page failed: ${reason}`;
    if (err instanceof HathError) {
      throw new HathError(err.statusCode, err.type, message);
    }
    throw new Error(message);
  }
}

/**
 * Map HathError (Nas, Dwar, driver) to a typed tool failure; keep the lane alive.
 * A `shape` that returns a string is sent as-is, so page text reaches the model
 * without a layer of JSON escaping; anything else is JSON-encoded. `state` keys a
 * successful read of page state (see ToolExecResult.state).
 */
export async function browserToolCall<T>(
  fn: () => Promise<T>,
  shape: (data: T) => unknown,
  audit: Record<string, unknown> | ((data: T) => Record<string, unknown>) = {},
  state?: (data: T) => string | undefined,
): Promise<ToolExecResult> {
  try {
    const data = await fn();
    const fields = typeof audit === "function" ? audit(data) : audit;
    const shaped = shape(data);
    const result =
      typeof shaped === "string"
        ? { content: shaped, isError: false, audit: fields }
        : ok(shaped, fields);
    const key = state?.(data);
    return key === undefined ? result : { ...result, state: key };
  } catch (err) {
    const fields = typeof audit === "function" ? {} : audit;
    if (err instanceof HathError) {
      return { content: `${err.type}: ${err.message}`, isError: true, audit: fields };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: message, isError: true, audit: fields };
  }
}
