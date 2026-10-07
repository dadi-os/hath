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
import type { ToolExecResult } from "./tools.js";
import { CONTINUE_TURN, type Wake } from "./wake.js";

const TERMINATED = "terminated by conversation lane";

/** What one lane needs to take steps against its agent's shared wake. */
export type StepDeps = {
  agentId: string;
  lane: Lane;
  wake: Wake;
  /** This lane's system prompt and tools, plus the windowed transcript. */
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
};

/**
 * syncWake freezes the system and transcript on the wake's first call; after
 * that, messages that landed since are appended once, where they arrived, for
 * both lanes.
 */
export function syncWake(deps: StepDeps, assembled: AssembledContext): void {
  if (!deps.wake.started) {
    deps.wake.begin(assembled.system, assembled.messages, assembled.throughSeq);
    return;
  }
  const arrived = deps.arrivalsSince(deps.wake.throughSeq);
  if (arrived.turn !== null) {
    deps.wake.push({ message: arrived.turn });
  }
  deps.wake.advance(arrived.throughSeq);
}

/**
 * The request a lane sends: the wake's frozen system, its tools, and the shared
 * wake. Reasoning gets tool_choice auto so it can think and write around its
 * tool calls. Conversation is forced to call a tool: its only outputs are
 * dispatch, steer and yield, and left free it writes `[To: …]` replies as plain
 * text, which never reach anyone and never end the lane.
 */
export function laneRequest(deps: StepDeps, assembled: AssembledContext): DwarChatRequest {
  return {
    system: deps.wake.system,
    messages: deps.wake.view(deps.lane),
    tools: assembled.tools,
    tool_choice: deps.lane === "reasoning" ? "auto" : "any",
  };
}

/**
 * runStep records one model turn and its tool results on the wake. A turn with
 * no tool call is kept and followed by a neutral continue turn, so the lane
 * keeps going; only yield (or a stop) ends it. Returns true when the lane
 * should exit. Agent turns are tagged with their provider and lane so Dwar can
 * translate the other lane's turns in a shared wake; the router's wake has one
 * lane on a context-free endpoint, so its turns go untagged.
 */
export async function runStep(
  deps: StepDeps,
  response: DwarChatResponse,
  isStopped: () => boolean,
): Promise<boolean> {
  const assistant: DwarMessage =
    deps.lane === "router"
      ? { role: "assistant", content: response.content }
      : { role: "assistant", content: response.content, provider: response.provider, lane: deps.lane };
  const uses = response.content.filter(
    (block): block is DwarToolUseBlock => block.type === "tool_use",
  );

  if (uses.length === 0) {
    if (response.stop_reason === "error") {
      throw new HathError(502, "dwar", `${deps.lane} model stopped with an error and no tool call`);
    }
    if (response.content.length === 0) {
      throw new HathError(502, "dwar", `${deps.lane} model returned an empty turn`);
    }
    deps.wake.push(
      { message: assistant },
      { message: { role: "user", content: CONTINUE_TURN } },
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
  deps.wake.push({ message: assistant }, { message: { role: "user", content: results }, states });
  if (yielded) {
    deps.wake.markYield(deps.lane);
  }
  return yielded || stopped || isStopped();
}
