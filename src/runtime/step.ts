/** One lane step against the shared wake: call the model, run its tools, record the turn whole. */

import { HathError } from "../errors.js";
import type {
  DwarChatRequest,
  DwarChatResponse,
  DwarMessage,
  DwarToolResultBlock,
  DwarToolUseBlock,
  Lane,
} from "../types/domain.js";
import { YIELD } from "../types/domain.js";
import type { AssembledContext } from "./context.js";
import { stepActions } from "./record.js";
import type { ToolExecResult } from "./tools.js";
import type { TranscriptStore } from "./transcript.js";
import { CAPPED_TURN, CAPPED_TURNS_MAX, CONTINUE_TURN, type Wake } from "./wake.js";

const TERMINATED = "terminated by conversation lane";

/** What one lane needs to take steps against its agent's shared wake. */
export type StepDeps = {
  agentId: string;
  lane: Lane;
  wake: Wake;
  /** This lane's system prompt and tools, plus each lane's windowed transcript. */
  assemble: () => Promise<AssembledContext>;
  /** Transcript entries newer than `afterSeq`, folded into one user turn. */
  arrivalsSince: (afterSeq: number) => { turn: DwarMessage | null; throughSeq: number };
  /** This lane's Dwar chat endpoint. */
  call: (request: DwarChatRequest) => Promise<DwarChatResponse>;
  executeTool: (call: DwarToolUseBlock) => Promise<ToolExecResult>;
  /** Writes the `response` log row; runs before the turn's tools. */
  logResponse: (response: DwarChatResponse) => Promise<void>;
  /** Writes the `tool_result` log row with the tool's name. */
  logToolResult: (call: DwarToolUseBlock, result: ToolExecResult) => Promise<void>;
  /** Adds a reasoning step that acted on the world to the agent's transcript (see record.ts). */
  recordActions: (actions: string) => void;
};

/**
 * syncWake freezes the system and both transcripts on the wake's first call; after
 * that, messages that landed since are appended once, where they arrived, for
 * both lanes.
 */
export function syncWake(deps: StepDeps, assembled: AssembledContext): void {
  if (!deps.wake.started) {
    deps.wake.begin(assembled.system, assembled.transcripts, assembled.throughSeq);
    return;
  }
  const arrived = deps.arrivalsSince(deps.wake.throughSeq);
  if (arrived.turn !== null) {
    deps.wake.push({ message: arrived.turn });
  }
  deps.wake.advance(arrived.throughSeq);
}

/**
 * The request a lane sends: the wake's frozen system, its tools, and its view
 * of the shared wake, trimmed to its token ceiling. Both agent lanes get tool_choice auto so they can think before acting
 * (a forced call skips thinking on Anthropic models); a conversation turn of
 * plain text reaches no one and is followed by a continue turn (see runStep).
 * The router, on a context-free endpoint, is forced to call a tool.
 */
export function laneRequest(deps: StepDeps, assembled: AssembledContext): DwarChatRequest {
  deps.wake.fit(deps.lane, assembled.tools);
  return {
    system: deps.wake.system,
    messages: deps.wake.view(deps.lane),
    tools: assembled.tools,
    tool_choice: deps.lane === "router" ? "any" : "auto",
  };
}

/** How much of an already-sent message a refusal quotes. */
const SENT_QUOTE_CHARS = 300;

/**
 * alreadySentRefusal is why `agentId`'s message to `to`, composed when its wake had read
 * the transcript through `composedThrough`, must not go out: a message this agent sent
 * `to` after that point, which the composing lane never saw. Both lanes send, and each
 * runs while the other may be sending, so without this a lane answers what the other
 * lane already answered. The refusal quotes what went out, so the lane sends only what
 * it adds. Null when nothing was sent `to` since.
 */
export function alreadySentRefusal(
  transcript: TranscriptStore,
  agentId: string,
  to: string | null,
  composedThrough: number,
): string | null {
  const sent = transcript
    .transcriptFor(agentId)
    .filter((row) => row.seq > composedThrough && row.fromAgentId === agentId && row.toAgentId === to && row.fromAgentId !== row.toAgentId)
    .at(-1);
  if (sent === undefined) {
    return null;
  }
  const who = to ?? "Ankur";
  const quote = sent.content.length > SENT_QUOTE_CHARS ? `${sent.content.slice(0, SENT_QUOTE_CHARS)}…` : sent.content;
  return `Not sent: this agent already sent ${who} a message after you wrote this one: "${quote}" Send ${who} only what that message does not already say, or nothing if it covers this.`;
}

/** How many times a lane asks again after its model returned an empty turn. */
const EMPTY_TURN_RETRIES = 1;

/**
 * callLane makes a lane's model call and logs the response, asking once more when the
 * model returned an empty turn (no thinking, text or call), which Gemini does now and
 * then on the conversation lane: three wakes failed that way between 2026-10-14 and
 * 2026-10-16, each sending its requester a lane-failure report.
 */
export async function callLane(deps: StepDeps, request: DwarChatRequest): Promise<DwarChatResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await deps.call(request);
    await deps.logResponse(response);
    if (response.content.length > 0 || response.stop_reason === "error" || attempt >= EMPTY_TURN_RETRIES) {
      return response;
    }
  }
}

/**
 * runStep records one model turn and its tool results on the wake, with what the
 * call measured (see Wake.measure) and what the turn cost to write; a reasoning
 * turn that called an action tool also joins the agent's transcript as a `[Did]`
 * entry, so the steps outlive the wake. A turn with
 * no tool call is kept and followed by a neutral continue turn, so the lane
 * keeps going; only yield (or a stop) ends it. An empty turn (see callLane) fails a
 * reasoning lane, but ends a conversation run as a yield would: conversation with
 * nothing to say has nothing to send. Returns true when the lane should exit. Agent turns are tagged with their provider and lane so Dwar can
 * translate the other lane's turns in a shared wake; the router's wake has one
 * lane on a context-free endpoint, so its turns go untagged.
 */
export async function runStep(
  deps: StepDeps,
  response: DwarChatResponse,
  isStopped: () => boolean,
): Promise<boolean> {
  deps.wake.measure(deps.lane, response.usage);
  const outputTokens = response.usage.output_tokens;
  const assistant: DwarMessage =
    deps.lane === "router"
      ? { role: "assistant", content: response.content }
      : { role: "assistant", content: response.content, provider: response.provider, lane: deps.lane };
  const uses = response.content.filter(
    (block): block is DwarToolUseBlock => block.type === "tool_use",
  );

  const capped = deps.wake.noteTurn(deps.lane, uses.length === 0 && response.stop_reason === "max_tokens");
  if (capped >= CAPPED_TURNS_MAX) {
    throw new HathError(
      502,
      "dwar",
      `${deps.lane} model ran out of output room while thinking ${capped} turns in a row without acting`,
    );
  }
  if (uses.length === 0) {
    if (response.stop_reason === "error") {
      throw new HathError(502, "dwar", `${deps.lane} model stopped with an error and no tool call`);
    }
    if (response.content.length === 0) {
      if (deps.lane === "conversation") {
        deps.wake.markYield(deps.lane);
        return true;
      }
      throw new HathError(502, "dwar", `${deps.lane} model returned an empty turn`);
    }
    deps.wake.push(
      { message: assistant, outputTokens },
      { message: { role: "user", content: capped > 0 ? CAPPED_TURN : CONTINUE_TURN } },
    );
    return false;
  }

  const results: DwarToolResultBlock[] = [];
  const states: Record<string, string> = {};
  let yielded = false;
  let stopped = false;
  for (const call of uses) {
    if (isStopped() && call.name !== YIELD) {
      const result: ToolExecResult = { content: TERMINATED, isError: true, audit: { terminated: true } };
      await deps.logToolResult(call, result);
      results.push({ type: "tool_result", tool_use_id: call.id, content: result.content, is_error: true });
      stopped = true;
      continue;
    }
    if (call.name === YIELD) {
      yielded = true;
    }
    const result = await deps.executeTool(call);
    await deps.logToolResult(call, result);
    results.push({
      type: "tool_result",
      tool_use_id: call.id,
      content: result.content,
      is_error: result.isError,
    });
    if (result.state !== undefined) {
      states[call.id] = result.state;
    }
    if (isStopped() && call.name !== YIELD) {
      stopped = true;
    }
  }
  deps.wake.push({ message: assistant, outputTokens }, { message: { role: "user", content: results }, states });
  if (deps.lane === "reasoning") {
    const actions = stepActions(response.content, new Map(results.map((result) => [result.tool_use_id, result])));
    if (actions !== null) {
      deps.recordActions(actions);
    }
  }
  if (yielded) {
    deps.wake.markYield(deps.lane);
  }
  return yielded || stopped || isStopped();
}
