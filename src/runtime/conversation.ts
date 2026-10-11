import type { DwarResponseBlock } from "../types/domain.js";
import { DISPATCH_MESSAGE, FORWARD_ATTACHMENT } from "../types/domain.js";
import type { IntentQueue } from "./intents.js";
import { formatIntentTurn } from "./intents.js";
import { laneRequest, runStep, syncWake, type StepDeps } from "./step.js";

/** Step deps plus the intent queue reasoning's send_message writes to. */
export type ConversationLoopDeps = StepDeps & {
  intents: IntentQueue;
};

/**
 * Conversation-lane loop over the agent's shared wake. It sees exactly what
 * reasoning sees — including reasoning's thinking, tool calls and results — so
 * status it reports comes from what actually happened. Reasoning's send_message
 * intents join the wake as conversation-only turns. A turn with no tool call
 * continues; the only clean exit is the embedded yield tool.
 * Skips the provider call when the visible history is empty or ends on an
 * assistant turn — providers reject those requests, and nothing is waiting —
 * or when nothing it can see has joined the wake since it last yielded, as
 * when several wake-ups queue behind one run that already handled them.
 * A yield that leaves this run's hand-offs unsent is answered once with a turn
 * counting them, since a send_message in reasoning's turns delivers nothing;
 * a second yield stands.
 */
export async function runConversationLoop(deps: ConversationLoopDeps): Promise<void> {
  let unsent = 0;
  let reminded = false;
  for (;;) {
    const assembled = await deps.assemble();
    syncWake(deps, assembled);
    const intents = deps.intents.drain(deps.agentId);
    if (intents.length > 0) {
      deps.wake.push({
        message: { role: "user", content: formatIntentTurn(intents) },
        only: "conversation",
      });
      unsent += intents.length;
    }

    const request = laneRequest(deps, assembled);
    const last = request.messages[request.messages.length - 1];
    if (!last || last.role !== "user" || deps.wake.unchangedSinceYield(deps.lane)) {
      return;
    }

    const response = await deps.call(request);
    await deps.logResponse(response);

    unsent = Math.max(0, unsent - sends(response.content));
    if (await runStep(deps, response, () => false)) {
      if (unsent > 0 && !reminded) {
        reminded = true;
        deps.wake.push({ message: { role: "user", content: unsentTurn(unsent) }, only: "conversation" });
        continue;
      }
      return;
    }
  }
}

/** sends counts the messages a conversation turn delivers. */
function sends(content: DwarResponseBlock[]): number {
  return content.filter(
    (block) => block.type === "tool_use" && (block.name === DISPATCH_MESSAGE || block.name === FORWARD_ATTACHMENT),
  ).length;
}

/** unsentTurn is the reminder a yield gets while `count` of this run's hand-offs are still unsent. */
function unsentTurn(count: number): string {
  return `[From: your reasoning lane]\nYou yielded with ${count} of my hand-offs from this run still unsent. My send_message delivers nothing; only your dispatch_message or forward_attachment does. Send each one now, or yield again if your own dispatch_message already delivered the same thing this wake.`;
}
