/** One step against the wake: call the model, run its tools, record the turn whole. */

import { HathError } from "../errors.js";
import type {
  DwarChatRequest,
  DwarChatResponse,
  DwarMessage,
  DwarToolResultBlock,
  DwarToolUseBlock,
} from "../types/domain.js";
import { INGEST_MEMORY, YIELD } from "../types/domain.js";
import { mergeIngests } from "./memory.js";
import type { Arrivals, AssembledContext } from "./context.js";
import type { ToolExecResult } from "./tools.js";
import { CAPPED_TURN, CAPPED_TURNS_MAX, CONTINUE_TURN, type Wake } from "./wake.js";

const TERMINATED = "stopped";

/** What a run needs to take steps against its wake. */
export type StepDeps = {
  agentId: string;
  wake: Wake;
  /** `any` forces a tool call (the router); `auto` lets the model think before acting (an agent: a forced call skips thinking on Anthropic models). */
  toolChoice: "auto" | "any";
  /** True tags each model turn with its provider so Dwar can translate another provider's turns; the router's, on a context-free endpoint, go untagged. */
  tagTurns: boolean;
  /** The system prompt, the tools and the windowed thread. */
  assemble: () => Promise<AssembledContext>;
  /** Thread entries newer than `afterSeq`, folded into a turn (see context.ts arrivalsSince). */
  arrivalsSince: (afterSeq: number) => Arrivals;
  /** The Dwar chat call; the signal aborts the request in flight. */
  call: (request: DwarChatRequest, signal?: AbortSignal) => Promise<DwarChatResponse>;
  executeTool: (call: DwarToolUseBlock) => Promise<ToolExecResult>;
  /** Writes the `response` log row; runs before the turn's tools. */
  logResponse: (response: DwarChatResponse) => Promise<void>;
  /** Writes the `tool_result` log row with the tool's name. */
  logToolResult: (call: DwarToolUseBlock, result: ToolExecResult) => Promise<void>;
  /**
   * What happens to a turn of text and no tool call (see send.ts replyWithText): true when the
   * text was taken as the agent's answer, which ends the run. Absent for the router, whose text is thought.
   */
  replyWithText?: (text: string) => Promise<boolean>;
};

/**
 * syncWake freezes the system and the thread on the wake's first call, followed by the wake
 * header (see header.ts), the job's earlier steps (see continuation.ts) and what arrived
 * after the last of them, so the arrival that woke the agent is read last; after that,
 * messages that landed since are appended once, where they arrived.
 */
export function syncWake(deps: StepDeps, assembled: AssembledContext): void {
  if (!deps.wake.started) {
    deps.wake.begin(assembled.system, assembled.thread, assembled.throughSeq);
    if (assembled.header !== undefined) {
      deps.wake.push({ message: { role: "user", content: assembled.header } });
    }
    if (assembled.continued !== undefined) {
      deps.wake.push(...assembled.continued);
    }
    if (assembled.arrived !== undefined) {
      deps.wake.push({ message: assembled.arrived });
    }
    return;
  }
  const arrived = deps.arrivalsSince(deps.wake.throughSeq);
  if (arrived.turn !== null) {
    deps.wake.push({ message: arrived.turn });
  }
  deps.wake.advance(arrived.throughSeq);
}

/**
 * The request a step sends: the wake's frozen system, its tools, and its view of the wake,
 * trimmed to the token ceiling.
 */
export function stepRequest(deps: StepDeps, assembled: AssembledContext): DwarChatRequest {
  deps.wake.fit(assembled.tools);
  return {
    system: deps.wake.system,
    messages: deps.wake.view(),
    tools: assembled.tools,
    tool_choice: deps.toolChoice,
  };
}

/** How many times the agent asks again after its model returned an empty turn. */
const EMPTY_TURN_RETRIES = 1;

/**
 * callModel makes the model call and logs the response, asking once more when the
 * model returned an empty turn (no thinking, text or call), which Gemini did now and
 * then: three wakes failed that way between 2026-10-14 and 2026-10-16. Null when `signal`
 * aborted while the call was out: the response is dropped unlogged.
 */
export async function callModel(
  deps: StepDeps,
  request: DwarChatRequest,
  signal?: AbortSignal,
): Promise<DwarChatResponse | null> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await deps.call(request, signal);
    if (signal?.aborted === true) {
      return null;
    }
    await deps.logResponse(response);
    if (response.content.length > 0 || response.stop_reason === "error" || attempt >= EMPTY_TURN_RETRIES) {
      return response;
    }
  }
}

/**
 * runStep records one model turn and its tool results on the wake, with what the
 * call measured (see Wake.measure) and what the turn cost to write. A turn with
 * no tool call is either the answer (see send.ts replyWithText) or is kept and followed
 * by a neutral continue turn, so the agent keeps going; only yield (or a stop) ends it. An
 * empty turn fails the run. Returns true when the run should exit.
 */
export async function runStep(
  deps: StepDeps,
  response: DwarChatResponse,
  isStopped: () => boolean,
): Promise<boolean> {
  deps.wake.measure(response.usage);
  const outputTokens = response.usage.output_tokens;
  const assistant: DwarMessage = deps.tagTurns ? { role: "assistant", content: response.content, provider: response.provider } : { role: "assistant", content: response.content };
  const uses = response.content.filter(
    (block): block is DwarToolUseBlock => block.type === "tool_use",
  );

  const capped = deps.wake.noteTurn(uses.length === 0 && response.stop_reason === "max_tokens");
  if (capped >= CAPPED_TURNS_MAX) {
    throw new HathError(
      502,
      "dwar",
      `model ran out of output room while thinking ${capped} turns in a row without acting`,
    );
  }
  if (uses.length === 0) {
    if (response.stop_reason === "error") {
      throw new HathError(502, "dwar", "model stopped with an error and no tool call");
    }
    if (response.content.length === 0) {
      throw new HathError(502, "dwar", "model returned an empty turn");
    }
    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
    if (text !== "" && deps.replyWithText !== undefined && (await deps.replyWithText(text))) {
      deps.wake.push({ message: assistant, outputTokens });
      deps.wake.markYield();
      return true;
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
  const merged = mergeIngests(uses.filter((call) => call.name === INGEST_MEMORY));
  for (const call of uses) {
    if (isStopped() && call.name !== YIELD) {
      const result: ToolExecResult = { content: TERMINATED, isError: true, audit: { terminated: true } };
      await deps.logToolResult(call, result);
      results.push({ type: "tool_result", tool_use_id: call.id, content: result.content, is_error: true });
      stopped = true;
      continue;
    }
    const result = merged === null || call.name !== INGEST_MEMORY ? await deps.executeTool(call) : await executeMerged(deps, merged, call);
    if (call.name === YIELD) {
      yielded = true;
    }
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
  if (yielded) {
    deps.wake.markYield();
  }
  return yielded || stopped || isStopped();
}

/**
 * executeMerged is the result of one ingest_memory call among several in a turn that went to
 * Yaad as one request: the first of them runs the request and returns what it stored; each
 * later one points at it, since the stored nodes carry no record of which text made them.
 */
async function executeMerged(deps: StepDeps, merged: { first: DwarToolUseBlock; call: DwarToolUseBlock }, call: DwarToolUseBlock): Promise<ToolExecResult> {
  if (call.id === merged.first.id) {
    return deps.executeTool(merged.call);
  }
  return { content: JSON.stringify({ stored_with: merged.first.id }), isError: false, audit: { stored_with: merged.first.id } };
}
