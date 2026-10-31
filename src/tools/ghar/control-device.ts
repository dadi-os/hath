import { z } from "zod";
import { CONTROL_GIVE_UP_MS, CONTROL_POLL_MS, CONTROL_WAIT_MS } from "../../constants.js";
import { HathError } from "../../errors.js";
import type { GharControlRun } from "../../ghar/client.js";
import { runInBackground } from "../../runtime/async.js";
import { CONTROL_DEVICE } from "../../types/domain.js";
import { fail, failWithoutAgentIdentity, ok, type ToolContext, type ToolExecResult } from "../shared.js";
import { defineTool } from "../types.js";

const input = z.object({ request: z.string().min(1) }).strict();

/** settled is the tool result for a control run that is no longer running. */
function settled(run: GharControlRun): ToolExecResult {
  if (run.status === "done") {
    return ok({ result: run.result });
  }
  return fail(run.error ? `${run.error.type}: ${run.error.message}` : "control run failed without a reason");
}

/** followRun reads Ghar's run until it settles, or reports it unfinished after CONTROL_GIVE_UP_MS. */
async function followRun(ctx: ToolContext, runId: string): Promise<ToolExecResult> {
  const giveUpAt = Date.now() + CONTROL_GIVE_UP_MS;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, CONTROL_POLL_MS));
    try {
      const run = await ctx.ghar.getControl(runId);
      if (run.status !== "running") {
        return settled(run);
      }
    } catch (err) {
      if (err instanceof HathError) {
        return fail(`${err.type}: ${err.message}. Ghar no longer knows this request, so read the devices with get_device to see what happened.`);
      }
      throw err;
    }
    if (Date.now() >= giveUpAt) {
      return fail("The request is still running in Ghar after 5 minutes. Read the devices with get_device to see where it stands.");
    }
  }
}

/**
 * Changes the house from a request in plain words, via Ghar `POST /control`, where Ghar's own
 * model loop does the reading and commanding. A request that settles within CONTROL_WAIT_MS
 * answers in the call; a slower one returns `{ pending }` and its result wakes the calling lane.
 */
export const controlDevice = defineTool({
  name: CONTROL_DEVICE,
  description:
    "Change the house, or ask it something that needs more than a read, in plain words: \"turn off the kitchen lights\", \"set the bedroom thermostat to 21\", \"close the garage door and tell me if it did\". Ghar finds the devices and runs the commands itself, and answers what changed and the state now, or what it could not do and why. One request may cover several devices or a whole room. A request that takes more than a few seconds returns { pending } at once and its answer arrives as a message that wakes you. To read devices yourself, use get_device.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      request: { type: "string", description: "What you want done or asked, as you would tell a person: which devices or rooms, and the change" },
    },
    required: ["request"],
  },
  async handler(ctx, parsed) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    if (ctx.callId === null) {
      throw new Error("control_device ran outside a tool call");
    }
    let run: GharControlRun;
    try {
      run = await ctx.ghar.control({ request: parsed.request, caller: ctx.callerId, wait_ms: CONTROL_WAIT_MS });
    } catch (err) {
      if (err instanceof HathError) {
        return fail(`${err.type}: ${err.message}`);
      }
      throw err;
    }
    if (run.status !== "running") {
      return settled(run);
    }
    return runInBackground(ctx, ctx.callerId, { type: "tool_use", id: ctx.callId, name: CONTROL_DEVICE, input: parsed }, () => followRun(ctx, run.id));
  },
});
