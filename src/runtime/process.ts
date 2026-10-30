import type { Db } from "../db/client.js";
import { pendingOutbox } from "../db/outbox.js";
import { HathError } from "../errors.js";
import { fail, type ToolExecResult } from "../tools/shared.js";
import type { DwarResponseBlock, DwarToolUseBlock } from "../types/domain.js";
import { SEND } from "../types/domain.js";
import { outboxTurn, unresolvedOutboxTurn } from "./outbox.js";
import { alreadySentRefusal, callLane, laneRequest, runStep, syncWake, type StepDeps } from "./step.js";
import type { TranscriptStore } from "./transcript.js";

/** Step deps plus what the send checks and the outbox read, and the status block's renderer. */
export type ProcessLoopDeps = StepDeps & {
  db: Db;
  transcript: TranscriptStore;
  /** The status block for the next call (see status.ts). */
  status: () => Promise<string>;
};

/**
 * Process-lane loop: the front desk and the agent's only voice. Its view is its system,
 * its own turns, what arrived, and hath's status block as the last turn of every call
 * (see status.ts); the work lane's thinking, tool calls and results are not in it. The
 * work lane's `message` calls reach it as a [Messages from work] turn; it sends them with
 * send, which closes the ones to that recipient, and a yield with one still waiting is
 * answered, up to OUTBOX_RETRIES times, before the lane fails loudly and the rest are
 * recorded as failed.
 * A turn with no tool call continues; the only clean exit is the embedded yield tool.
 * Skips the provider call when the visible history is empty or ends on an assistant turn
 * (providers reject those requests, and nothing is waiting) or when nothing it can see has
 * joined the wake since it last yielded, as when several wake-ups queue behind one run
 * that already handled them. A yield in a turn that wrote a message's worth of text and
 * sent nothing is answered once, since text reaches no one.
 * The only refusals on a send are race-safety checks (see sendRefusal and
 * alreadySentRefusal): a message from the recipient the lane has not read yet, and one
 * already sent to the recipient since the lane composed this. A turn whose send was
 * refused does not end on its yield: the lane gets a turn saying so and sends again, up
 * to REFUSED_SEND_RETRIES times a run, since a refused message that ends the run is a
 * message nobody sent.
 */
export async function runProcessLoop(deps: ProcessLoopDeps): Promise<void> {
  let textReminded = false;
  let refusedRetries = 0;
  let outboxRetries = 0;
  for (;;) {
    const assembled = await deps.assemble();
    syncWake(deps, assembled);
    await showOutbox(deps);
    const composedThrough = deps.wake.throughSeq;

    const last = deps.wake.view("process", false).at(-1);
    if (!last || last.role !== "user" || deps.wake.unchangedSinceYield(deps.lane)) {
      return;
    }
    deps.wake.setStatus(await deps.status());
    const request = laneRequest(deps, assembled);

    const response = await callLane(deps, request);

    const sent = sends(response.content);
    let refused = false;
    const gated = async (call: DwarToolUseBlock): Promise<ToolExecResult> => {
      if (call.name !== SEND) {
        return deps.executeTool(call);
      }
      const to = recipientOf(call);
      if (to === undefined) {
        return deps.executeTool(call);
      }
      const refusal = sendRefusal(deps, to) ?? alreadySentRefusal(deps.transcript, deps.agentId, to, composedThrough);
      const result = refusal === null ? await deps.executeTool(call) : fail(refusal);
      if (result.isError) {
        refused = true;
      }
      return result;
    };
    if (await runStep({ ...deps, executeTool: gated }, response, () => false)) {
      if (refused && refusedRetries < REFUSED_SEND_RETRIES) {
        refusedRetries += 1;
        deps.wake.push({ message: { role: "user", content: REFUSED_SEND_TURN }, only: "process" });
        continue;
      }
      if (await showOutbox(deps)) {
        continue;
      }
      const waiting = await pendingOutbox(deps.db, deps.agentId);
      if (waiting.length > 0) {
        if (outboxRetries >= OUTBOX_RETRIES) {
          throw new HathError(
            500,
            "outbox_unresolved",
            `the process lane ended with messages from the work lane still waiting: ${waiting.map((row) => `#${row.id}`).join(", ")}`,
          );
        }
        outboxRetries += 1;
        deps.wake.push({ message: { role: "user", content: unresolvedOutboxTurn(waiting) }, only: "process" });
        continue;
      }
      if (sent === 0 && textChars(response.content) >= UNSENT_TEXT_CHARS && !textReminded) {
        textReminded = true;
        deps.wake.push({ message: { role: "user", content: UNSENT_TEXT_TURN }, only: "process" });
        continue;
      }
      return;
    }
  }
}

/** How many times a run answers a yield while work-lane messages wait before the lane fails. */
const OUTBOX_RETRIES = 3;

/**
 * showOutbox puts the work lane's messages the lane has not yet been shown into its view
 * as one turn, so a message queued mid-wake reaches it, and a run that starts on one has
 * news. True when it showed any.
 */
async function showOutbox(deps: ProcessLoopDeps): Promise<boolean> {
  const unseen = (await pendingOutbox(deps.db, deps.agentId)).filter((row) => !deps.wake.outboxShown.has(row.id));
  if (unseen.length === 0) {
    return false;
  }
  for (const row of unseen) {
    deps.wake.outboxShown.add(row.id);
  }
  deps.wake.push({ message: { role: "user", content: outboxTurn(unseen) }, only: "process" });
  return true;
}

/** recipientOf is who a send call is for (null is Ankur); undefined when the call names no recipient the checks can judge. */
function recipientOf(call: DwarToolUseBlock): string | null | undefined {
  const to = (call.input as { to?: unknown }).to;
  if (typeof to !== "string") {
    return undefined;
  }
  return /^ankur$/i.test(to.trim()) ? null : to.trim();
}

/**
 * sendRefusal is why this turn's message to `to` must not go out, or null when it may.
 * The one check is race safety: when `to` wrote after the lane's last sync, the send
 * waits for the next step, which shows it.
 */
function sendRefusal(deps: ProcessLoopDeps, to: string | null): string | null {
  const unread = deps.transcript
    .transcriptFor(deps.agentId)
    .some((row) => row.seq > deps.wake.throughSeq && row.fromAgentId === to && row.toAgentId === deps.agentId);
  return unread ? `Not sent: ${to ?? "Ankur"} wrote to you after you composed this. Read the new message first, then send what still holds.` : null;
}

/** How many times a run answers a yield after a refused send before the yield stands. */
const REFUSED_SEND_RETRIES = 3;

/** The turn a yield gets when a send in the same turn was refused. */
export const REFUSED_SEND_TURN =
  "[continue] A message in your last turn was not sent: its result says why. Send it again the way that result says, or yield if it no longer applies.";

/** A process-lane turn whose text is at least this long, sent nowhere, reads as a message left unsent. */
const UNSENT_TEXT_CHARS = 400;

/** The reminder a yield gets after a turn wrote a message's worth of text and sent nothing. */
export const UNSENT_TEXT_TURN =
  "[continue] Your last turn wrote a message as text and sent nothing: text reaches no one. If it was meant for someone, send it with send now; otherwise yield again.";

/** textChars is the length of a turn's visible text, not counting its thinking. */
export function textChars(content: DwarResponseBlock[]): number {
  return content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
}

/** sends counts the messages a process-lane turn delivers. */
function sends(content: DwarResponseBlock[]): number {
  return content.filter((block) => block.type === "tool_use" && block.name === SEND).length;
}
