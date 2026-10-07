import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DwarChatRequest,
  DwarChatResponse,
  DwarMessage,
  DwarResponseBlock,
  Lane,
} from "../src/types/domain.js";
import { runConversationLoop } from "../src/runtime/conversation.js";
import { IntentQueue } from "../src/runtime/intents.js";
import { runReasoningLoop } from "../src/runtime/reasoning.js";
import type { StepDeps } from "../src/runtime/step.js";
import { SteerQueue, STEER_TURN_PREFIX } from "../src/runtime/steer.js";
import { CLEARED_RESULT, CONTINUE_TURN, Wake, WakeStore } from "../src/runtime/wake.js";
import { roomyWakeLimits } from "./helpers.js";

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function turn(
  provider: DwarChatResponse["provider"],
  content: DwarResponseBlock[],
): DwarChatResponse {
  const calls = content.some((block) => block.type === "tool_use");
  return { provider, content, stop_reason: calls ? "tool_use" : "end_turn", usage };
}

function call(name: string, id: string): DwarResponseBlock {
  return { type: "tool_use", id, name, input: {} };
}

function stepDeps(
  lane: Lane,
  wake: Wake,
  model: (request: DwarChatRequest) => DwarChatResponse,
  requests: DwarChatRequest[],
): StepDeps {
  return {
    agentId: "agent-1",
    lane,
    wake,
    assemble: async () => ({
      system: "sys",
      messages: [{ role: "user", content: "[From: Ankur]\ncheck my email" }],
      tools: [],
      throughSeq: 1,
    }),
    arrivalsSince: (afterSeq) => ({ turn: null, throughSeq: afterSeq }),
    call: async (request) => {
      requests.push(structuredClone(request));
      return model(request);
    },
    executeTool: async (use) => ({ content: `full result of ${use.id} `.repeat(200), isError: false, audit: {} }),
    logResponse: async () => {},
    logToolResult: async () => {},
  };
}

function toolResults(messages: DwarMessage[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_result") {
        out.push(block.content);
      }
    }
  }
  return out;
}

test("under its budget, reasoning keeps every full tool result and its own thinking for the whole wake", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runReasoningLoop({
    ...stepDeps("reasoning", new Wake(roomyWakeLimits), () => {
      n += 1;
      if (n <= 12) {
        return turn("anthropic", [
          { type: "thinking", thinking: `step ${n}: the page did not change`, signature: `sig-${n}` },
          { type: "text", text: `Taking a screenshot (${n}).` },
          call("browser_screenshot", `s${n}`),
        ]);
      }
      return turn("anthropic", [call("yield", "y")]);
    }, requests),
    steer: new SteerQueue(),
  });

  const last = requests.at(-1)!;
  assert.equal(last.tool_choice, "auto");
  const results = toolResults(last.messages);
  assert.equal(results.length, 12);
  assert.ok(results.every((result) => result.startsWith("full result of s")));
  const assistants = last.messages.filter((m) => m.role === "assistant");
  assert.equal(assistants.length, 12);
  assert.deepEqual(assistants[0], {
    role: "assistant",
    provider: "anthropic",
    lane: "reasoning",
    content: [
      { type: "thinking", thinking: "step 1: the page did not change", signature: "sig-1" },
      { type: "text", text: "Taking a screenshot (1)." },
      call("browser_screenshot", "s1"),
    ],
  });
});

test("past its budget the wake clears older tool results in jumps, keeping every turn and the newest results", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runReasoningLoop({
    ...stepDeps(
      "reasoning",
      new Wake({ toolResultsMaxChars: 10_000, toolResultsKeptChars: 4_000 }),
      () => {
        n += 1;
        return n <= 12
          ? turn("anthropic", [call("browser_accessibility_tree", `s${n}`)])
          : turn("anthropic", [call("yield", "y")]);
      },
      requests,
    ),
    steer: new SteerQueue(),
  });

  const results = toolResults(requests.at(-1)!.messages);
  assert.equal(results.length, 12);
  assert.ok(results.slice(0, 10).every((result) => result === CLEARED_RESULT));
  assert.ok(results.slice(10).every((result) => result.startsWith("full result of s")));

  let rewrites = 0;
  for (let i = 1; i < requests.length; i += 1) {
    const before = requests[i - 1]!.messages;
    if (JSON.stringify(requests[i]!.messages.slice(0, before.length)) !== JSON.stringify(before)) {
      rewrites += 1;
    }
  }
  assert.equal(rewrites, 5);
});

test("a wake keeps the system it began with, so prompt changes land at the next wake", async () => {
  const requests: DwarChatRequest[] = [];
  let systems = 0;
  let n = 0;
  await runReasoningLoop({
    ...stepDeps("reasoning", new Wake(roomyWakeLimits), () => {
      n += 1;
      return turn("anthropic", [call(n < 3 ? "modify_agent_prompt" : "yield", `m${n}`)]);
    }, requests),
    assemble: async () => {
      systems += 1;
      return {
        system: `sys v${systems}`,
        messages: [{ role: "user", content: "[From: Ankur]\ncheck my email" }],
        tools: [],
        throughSeq: 1,
      };
    },
    steer: new SteerQueue(),
  });

  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.system === "sys v1"));
});

test("only the transcript's last turn carries the cache breakpoint", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runReasoningLoop({
    ...stepDeps("reasoning", new Wake(roomyWakeLimits), () => {
      n += 1;
      return turn("anthropic", [call(n < 3 ? "browser_navigate" : "yield", `b${n}`)]);
    }, requests),
    steer: new SteerQueue(),
  });

  for (const request of requests) {
    const marked = request.messages.flatMap((message, index) => (message.cache_breakpoint ? [index] : []));
    assert.deepEqual(marked, [0]);
  }
});

test("a turn without a tool call continues the lane; only yield ends it", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runReasoningLoop({
    ...stepDeps("reasoning", new Wake(roomyWakeLimits), () => {
      n += 1;
      if (n === 1) {
        return turn("anthropic", [
          { type: "thinking", thinking: "browser 15 is down", signature: "s" },
          { type: "text", text: "Browser 15 is not running; I should report that." },
        ]);
      }
      return turn("anthropic", [call("yield", "y")]);
    }, requests),
    steer: new SteerQueue(),
  });

  assert.equal(requests.length, 2);
  const second = requests[1]!.messages;
  assert.equal(second.at(-2)?.role, "assistant");
  assert.deepEqual(second.at(-1), { role: "user", content: CONTINUE_TURN });
});

test("an empty turn or a provider error with no tool call fails the lane instead of looping", async () => {
  for (const response of [
    turn("anthropic", []),
    { ...turn("anthropic", [{ type: "text", text: "refused" }]), stop_reason: "error" as const },
  ]) {
    await assert.rejects(
      runReasoningLoop({
        ...stepDeps("reasoning", new Wake(roomyWakeLimits), () => response, []),
        steer: new SteerQueue(),
      }),
    );
  }
});

test("both lanes share one wake: each sees the other's steps; steers and intents stay private", async () => {
  const wake = new Wake(roomyWakeLimits);
  const steer = new SteerQueue();
  const intents = new IntentQueue();
  const reasoningRequests: DwarChatRequest[] = [];
  const conversationRequests: DwarChatRequest[] = [];

  steer.append("agent-1", "open Gmail and search newer_than:1d");
  let r = 0;
  await runReasoningLoop({
    ...stepDeps("reasoning", wake, () => {
      r += 1;
      if (r === 1) {
        return turn("anthropic", [
          { type: "thinking", thinking: "navigate first", signature: "sig" },
          call("browser_navigate", "nav-1"),
        ]);
      }
      return turn("anthropic", [call("yield", "r-y")]);
    }, reasoningRequests),
    steer,
  });

  intents.append("agent-1", { toAgentId: null, intent: "tell Ankur browser 15 is down", attachmentIds: [] });
  await runConversationLoop({
    ...stepDeps("conversation", wake, () => turn("gemini", [call("yield", "c-y")]), conversationRequests),
    intents,
  });

  const seen = JSON.stringify(conversationRequests[0]!.messages);
  assert.ok(seen.includes("navigate first"));
  assert.ok(seen.includes("browser_navigate"));
  assert.ok(seen.includes("full result of nav-1"));
  assert.ok(seen.includes("tell Ankur browser 15 is down"));
  assert.ok(!seen.includes(STEER_TURN_PREFIX));

  const reasoningView = wake.view("reasoning");
  const reasoningBlob = JSON.stringify(reasoningView);
  assert.ok(reasoningBlob.includes(STEER_TURN_PREFIX));
  assert.ok(!reasoningBlob.includes("tell Ankur browser 15 is down"));
  const conversationTurn = reasoningView.find((m) => m.lane === "conversation");
  assert.equal(conversationTurn?.provider, "gemini");
});

test("a conversation intent stays in view while the lane keeps calling tools", async () => {
  const intents = new IntentQueue();
  intents.append("agent-1", { toAgentId: null, intent: "tell Ankur the profile URL", attachmentIds: [] });
  const requests: DwarChatRequest[] = [];
  let n = 0;

  await runConversationLoop({
    ...stepDeps("conversation", new Wake(roomyWakeLimits), () => {
      n += 1;
      return turn("gemini", [call(n < 3 ? "list_agents" : "yield", `c${n}`)]);
    }, requests),
    intents,
  });

  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.tool_choice, "any");
    assert.ok(JSON.stringify(request.messages).includes("tell Ankur the profile URL"));
  }
});

test("a wake lives while any run holds it and is dropped when the last releases", () => {
  const wakes = new WakeStore(roomyWakeLimits);
  const first = wakes.hold("agent-1");
  const wake = wakes.get("agent-1");
  wake.begin("sys", [{ role: "user", content: "hi" }], 1);
  wake.push({ message: { role: "assistant", content: "noted" } });

  const second = wakes.hold("agent-1");
  first();
  first();
  assert.equal(wakes.get("agent-1"), wake);

  second();
  const next = wakes.get("agent-1");
  assert.notEqual(next, wake);
  assert.equal(next.started, false);
});

test("a queued conversation run makes no model call until something it can see joins the wake", async () => {
  const wake = new Wake(roomyWakeLimits);
  const intents = new IntentQueue();
  const requests: DwarChatRequest[] = [];
  let arrival: DwarMessage | null = null;
  const deps = {
    ...stepDeps("conversation", wake, () => turn("gemini", [call("yield", `y${requests.length}`)]), requests),
    arrivalsSince: (afterSeq: number) => {
      const next = arrival;
      arrival = null;
      return next === null ? { turn: null, throughSeq: afterSeq } : { turn: next, throughSeq: afterSeq + 1 };
    },
    intents,
  };

  await runConversationLoop(deps);
  assert.equal(requests.length, 1);

  await runConversationLoop(deps);
  wake.push({ message: { role: "user", content: "steer: look again" }, only: "reasoning" });
  await runConversationLoop(deps);
  assert.equal(requests.length, 1);

  arrival = { role: "user", content: "[Arrived during this wake]\n\n[From: Ankur]\nany update?" };
  await runConversationLoop(deps);
  assert.equal(requests.length, 2);

  intents.append("agent-1", { toAgentId: null, intent: "tell Ankur it is done", attachmentIds: [] });
  await runConversationLoop(deps);
  assert.equal(requests.length, 3);
});
