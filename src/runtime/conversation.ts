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
 * a second yield stands. A yield in a turn that wrote a message's worth of text
 * and sent nothing is answered once the same way, since text reaches no one.
 */
export async function runConversationLoop(deps: ConversationLoopDeps): Promise<void> {
  let unsent = 0;
  let reminded = false;
  let textReminded = false;
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

    const sent = sends(response.content);
    unsent = Math.max(0, unsent - sent);
    if (await runStep(deps, response, () => false)) {
      if (unsent > 0 && !reminded) {
        reminded = true;
        deps.wake.push({ message: { role: "user", content: unsentTurn(unsent) }, only: "conversation" });
        continue;
      }
      if (sent === 0 && textChars(response.content) >= UNSENT_TEXT_CHARS && !textReminded) {
        textReminded = true;
        deps.wake.push({ message: { role: "user", content: UNSENT_TEXT_TURN }, only: "conversation" });
        continue;
      }
      return;
    }
  }
}

/** A conversation turn whose text is at least this long, sent nowhere, reads as a message left unsent. */
const UNSENT_TEXT_CHARS = 400;

/** The reminder a yield gets after a turn wrote a message's worth of text and sent nothing. */
export const UNSENT_TEXT_TURN =
  "[continue] Your last turn wrote a message as text and sent nothing: text reaches no one. If it was meant for someone, send it with dispatch_message now; otherwise yield again.";

/** textChars is the length of a turn's visible text, not counting its thinking. */
function textChars(content: DwarResponseBlock[]): number {
  return content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
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
