import type { Db } from "../db/client.js";
import { getHandoff, pendingHandoffs } from "../db/handoffs.js";
import { HathError } from "../errors.js";
import { fail, type ToolExecResult } from "../tools/shared.js";
import type { DwarResponseBlock, DwarToolUseBlock } from "../types/domain.js";
import { DISPATCH_MESSAGE, FORWARD_ATTACHMENT } from "../types/domain.js";
import { handoffsTurn, unresolvedHandoffsTurn } from "./handoffs.js";
import { opensLine } from "./jobs.js";
import { alreadySentRefusal, callLane, laneRequest, runStep, syncWake, type StepDeps } from "./step.js";
import type { TranscriptStore } from "./transcript.js";

/** Step deps plus what the send gates read. */
export type ConversationLoopDeps = StepDeps & {
  db: Db;
  transcript: TranscriptStore;
};

/**
 * Conversation-lane loop over the agent's shared wake. It sees exactly what
 * reasoning sees — including reasoning's thinking, tool calls and results — so what it
 * says comes from what actually happened, and it is the only lane that sends to Ankur
 * and to every agent but the ones its reasoning lane brought in. Reasoning's hand-offs
 * reach it as a [Hand-offs waiting] turn; it sends each (dispatch_message handoff_id)
 * or declines it (decline_handoff), and a yield with one still waiting is answered, up to
 * HANDOFF_RETRIES times, before the lane fails loudly and the rest are recorded as failed.
 * A turn with no tool call continues; the only clean exit is the embedded
 * yield tool.
 * Skips the provider call when the visible history is empty or ends on an
 * assistant turn — providers reject those requests, and nothing is waiting —
 * or when nothing it can see has joined the wake since it last yielded, as
 * when several wake-ups queue behind one run that already handled them.
 * A yield in a turn that wrote a message's worth of text and sent nothing is answered
 * once, since text reaches no one. Every send passes the gates in sendRefusal and
 * alreadySentRefusal first, the second against what reasoning sent meanwhile. A
 * turn whose send was refused (here or by the tool's own report gates) does not end on
 * its yield: the lane gets a turn saying so and sends again, up to REFUSED_SEND_RETRIES
 * times a run, since a refused message that ends the run is a message nobody sent.
 */
export async function runConversationLoop(deps: ConversationLoopDeps): Promise<void> {
  let textReminded = false;
  let refusedRetries = 0;
  let handoffRetries = 0;
  for (;;) {
    const assembled = await deps.assemble();
    syncWake(deps, assembled);
    await showHandoffs(deps);
    const composedThrough = deps.wake.throughSeq;

    const request = laneRequest(deps, assembled);
    const last = request.messages[request.messages.length - 1];
    if (!last || last.role !== "user" || deps.wake.unchangedSinceYield(deps.lane)) {
      return;
    }

    const response = await callLane(deps, request);

    const sent = sends(response.content);
    const sentTo = new Set<string | null>();
    let refused = false;
    const gated = async (call: DwarToolUseBlock): Promise<ToolExecResult> => {
      if (call.name !== DISPATCH_MESSAGE && call.name !== FORWARD_ATTACHMENT) {
        return deps.executeTool(call);
      }
      const to = await recipientOf(deps.db, call);
      if (to === undefined) {
        return deps.executeTool(call);
      }
      const refusal = (await sendRefusal(deps, to, sentTo)) ?? alreadySentRefusal(deps.transcript, deps.agentId, to, composedThrough);
      const result = refusal === null ? await deps.executeTool(call) : fail(refusal);
      if (result.isError) {
        refused = true;
        return result;
      }
      sentTo.add(to);
      return result;
    };
    if (await runStep({ ...deps, executeTool: gated }, response, () => false)) {
      if (refused && refusedRetries < REFUSED_SEND_RETRIES) {
        refusedRetries += 1;
        deps.wake.push({ message: { role: "user", content: REFUSED_SEND_TURN }, only: "conversation" });
        continue;
      }
      if (await showHandoffs(deps)) {
        continue;
      }
      const waiting = await pendingHandoffs(deps.db, deps.agentId);
      if (waiting.length > 0) {
        if (handoffRetries >= HANDOFF_RETRIES) {
          throw new HathError(
            500,
            "handoff_unresolved",
            `the conversation lane ended with hand-offs still waiting: ${waiting.map((handoff) => `#${handoff.id}`).join(", ")}`,
          );
        }
        handoffRetries += 1;
        deps.wake.push({ message: { role: "user", content: unresolvedHandoffsTurn(waiting) }, only: "conversation" });
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

/** How many times a run answers a yield while hand-offs wait before the lane fails. */
const HANDOFF_RETRIES = 3;

/**
 * showHandoffs puts the hand-offs the lane has not yet been shown into its view as one
 * turn, so a hand-off made mid-wake reaches it, and a run that starts on one has news.
 * True when it showed any.
 */
async function showHandoffs(deps: ConversationLoopDeps): Promise<boolean> {
  const unseen = (await pendingHandoffs(deps.db, deps.agentId)).filter((handoff) => !deps.wake.handoffsShown.has(handoff.id));
  if (unseen.length === 0) {
    return false;
  }
  for (const handoff of unseen) {
    deps.wake.handoffsShown.add(handoff.id);
  }
  deps.wake.push({ message: { role: "user", content: handoffsTurn(unseen) }, only: "conversation" });
  return true;
}

/**
 * recipientOf is who a send call is for: the hand-off's recipient when it sends one, else
 * the call's own to_agent_id; undefined when the call names no recipient the gates can judge.
 */
async function recipientOf(db: Db, call: DwarToolUseBlock): Promise<string | null | undefined> {
  const input = call.input as { to_agent_id?: string | null; handoff_id?: unknown };
  if (call.name === DISPATCH_MESSAGE && typeof input.handoff_id === "number") {
    return (await getHandoff(db, input.handoff_id))?.toAgentId;
  }
  return input.to_agent_id;
}

/**
 * sendRefusal is why this turn's message to `to` must not go out, or null when it may.
 * One message per recipient per turn (gate 4): everything for one recipient, files
 * included, goes in one message. No send over a message the lane has not read (gate 5):
 * when `to` wrote after the lane's last sync, the send waits for the next step, which
 * shows it. One voice per downstream line (gate 10): an agent this agent brought in (it
 * opened that line) is directed by the reasoning lane, which sends it everything itself.
 */
async function sendRefusal(
  deps: ConversationLoopDeps,
  to: string | null,
  sentTo: Set<string | null>,
): Promise<string | null> {
  const who = to ?? "Ankur";
  if (sentTo.has(to)) {
    return `Not sent: you already sent ${who} a message in this turn. Put everything for ${who} in one message; forward_attachment carries the text and the files together.`;
  }
  const unread = deps.transcript
    .transcriptFor(deps.agentId)
    .some((row) => row.seq > deps.wake.throughSeq && row.fromAgentId === to && row.toAgentId === deps.agentId);
  if (unread) {
    return `Not sent: ${who} wrote to you after you composed this. Read the new message first, then send what still holds.`;
  }
  if (to !== null && (await opensLine(deps.db, deps.agentId, to))) {
    return `Not sent: ${to} is an agent you brought in, and your reasoning lane directs it and sends it everything itself. To change ${to}'s work, steer reasoning.`;
  }
  return null;
}

/** How many times a run answers a yield after a refused send before the yield stands. */
const REFUSED_SEND_RETRIES = 3;

/** The turn a yield gets when a send in the same turn was refused. */
export const REFUSED_SEND_TURN =
  "[continue] A message in your last turn was not sent: its result says why. Send it again the way that result says, or yield if it no longer applies.";

/** A conversation turn whose text is at least this long, sent nowhere, reads as a message left unsent. */
const UNSENT_TEXT_CHARS = 400;

/** The reminder a yield gets after a turn wrote a message's worth of text and sent nothing. */
export const UNSENT_TEXT_TURN =
  "[continue] Your last turn wrote a message as text and sent nothing: text reaches no one. If it was meant for someone, send it with dispatch_message now; otherwise yield again.";

/** textChars is the length of a turn's visible text, not counting its thinking. */
export function textChars(content: DwarResponseBlock[]): number {
  return content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
}

/** sends counts the messages a conversation turn delivers. */
function sends(content: DwarResponseBlock[]): number {
  return content.filter(
    (block) => block.type === "tool_use" && (block.name === DISPATCH_MESSAGE || block.name === FORWARD_ATTACHMENT),
  ).length;
}
