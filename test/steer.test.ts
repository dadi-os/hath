import assert from "node:assert/strict";
import { test } from "node:test";
import type { DwarChatRequest, DwarChatResponse } from "../src/types/domain.js";
import { runReasoningLoop } from "../src/runtime/reasoning.js";
import { SteerQueue, STEER_TURN_PREFIX } from "../src/runtime/steer.js";
import { LaneLocks } from "../src/runtime/locks.js";
import { IntentQueue } from "../src/runtime/intents.js";
import { executeTool } from "../src/runtime/tools.js";
import { HostSessions } from "../src/runtime/sessions.js";
import { ToolDebounce } from "../src/runtime/tool-debounce.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { STEER_REASONING } from "../src/types/domain.js";
import { Wake } from "../src/runtime/wake.js";
import { roomyWakeLimits } from "./helpers.js";

const noDebounce = new ToolDebounce({ base_ms: 1, max_ms: 1 });

function toolUse(name: string, input: unknown): DwarChatResponse {
  return {
    provider: "anthropic",
    content: [{ type: "tool_use", id: "call-1", name, input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

test("a steer arriving mid-loop is applied on the next iteration", async () => {
  const steer = new SteerQueue();
  const agentId = "agent-1";
  const calls: DwarChatRequest[] = [];
  let turn = 0;

  await runReasoningLoop({
    agentId,
    lane: "reasoning",
    wake: new Wake(roomyWakeLimits),
    assemble: async () => ({ system: "sys", messages: [], tools: [], throughSeq: 0 }),
    arrivalsSince: (afterSeq) => ({ turn: null, throughSeq: afterSeq }),
    call: async (request) => {
      calls.push(request);
      turn += 1;
      if (turn === 1) {
        steer.append(agentId, "check the voice PR");
        return toolUse("send_message", { to_agent_id: null, intent: "status" });
      }
      return toolUse("yield", {});
    },
    executeTool: async () => ({ content: "{}", isError: false, audit: {} }),
    steer,
    logResponse: async () => {},
    logToolResult: async () => {},
  });

  assert.equal(calls.length, 2);
  const second = calls[1];
  assert.ok(second);
  const texts = second.messages.map((message) =>
    typeof message.content === "string" ? message.content : "",
  );
  assert.ok(texts.some((text) => text.includes(STEER_TURN_PREFIX) && text.includes("check the voice PR")));
});

test("a steer stays in view for the rest of the wake, not just the next call", async () => {
  const steer = new SteerQueue();
  const agentId = "agent-steer-persist";
  const calls: DwarChatRequest[] = [];
  let turn = 0;

  await runReasoningLoop({
    agentId,
    lane: "reasoning",
    wake: new Wake(roomyWakeLimits),
    assemble: async () => ({ system: "sys", messages: [], tools: [], throughSeq: 0 }),
    arrivalsSince: (afterSeq) => ({ turn: null, throughSeq: afterSeq }),
    call: async (request) => {
      calls.push(structuredClone(request));
      turn += 1;
      if (turn === 1) {
        steer.append(agentId, "use the google pivot");
      }
      return turn < 4
        ? { ...toolUse("wait", { seconds: 1 }), content: [{ type: "tool_use", id: `w${turn}`, name: "wait", input: { seconds: 1 } }] }
        : toolUse("yield", {});
    },
    executeTool: async () => ({ content: "{}", isError: false, audit: {} }),
    steer,
    logResponse: async () => {},
    logToolResult: async () => {},
  });

  assert.equal(calls.length, 4);
  for (const later of calls.slice(1)) {
    const texts = later.messages.map((message) =>
      typeof message.content === "string" ? message.content : "",
    );
    assert.ok(texts.some((text) => text.includes("use the google pivot")));
  }
});

test("steer_reasoning starts a run when reasoning is idle", async () => {
  const locks = new LaneLocks();
  const steer = new SteerQueue();
  const started: string[] = [];
  const agentId = "00000000-0000-4000-8000-0000000000dd";
  const result = await executeTool(
    {
      db: {} as never,
      callerId: agentId,
      callerKind: "agent",
      lane: "conversation",
      steer,
      intents: new IntentQueue(),
      locks,
      transcript: new TranscriptStore(),
      sessions: new HostSessions(),
      toolDebounce: noDebounce,
      enqueueConversation: () => {},
      enqueueReasoning: (id) => {
        started.push(id);
      },
    },
    {
      type: "tool_use",
      id: "s1",
      name: STEER_REASONING,
      input: { instruction: "look into it" },
    },
  );
  assert.equal(result.isError, false);
  assert.deepEqual(started, [agentId]);
  assert.equal(steer.hasItems(agentId), true);
});

test("steer_reasoning does not start a second run while reasoning is busy", async () => {
  const locks = new LaneLocks();
  const steer = new SteerQueue();
  const agentId = "00000000-0000-4000-8000-0000000000ee";
  const release = await locks.acquire(agentId, "reasoning", 1000);
  const started: string[] = [];
  await executeTool(
    {
      db: {} as never,
      callerId: agentId,
      callerKind: "agent",
      lane: "conversation",
      steer,
      intents: new IntentQueue(),
      locks,
      transcript: new TranscriptStore(),
      sessions: new HostSessions(),
      toolDebounce: noDebounce,
      enqueueConversation: () => {},
      enqueueReasoning: (id) => {
        started.push(id);
      },
    },
    {
      type: "tool_use",
      id: "s2",
      name: STEER_REASONING,
      input: { instruction: "wait your turn" },
    },
  );
  release();
  assert.deepEqual(started, []);
  assert.equal(steer.hasItems(agentId), true);
});

test("steer_reasoning with terminate stops the next tool call from running", async () => {
  const steer = new SteerQueue();
  const agentId = "agent-terminate";
  const executed: string[] = [];
  let turn = 0;

  await runReasoningLoop({
    agentId,
    lane: "reasoning",
    wake: new Wake(roomyWakeLimits),
    assemble: async () => ({ system: "sys", messages: [], tools: [], throughSeq: 0 }),
    arrivalsSince: (afterSeq) => ({ turn: null, throughSeq: afterSeq }),
    call: async () => {
      turn += 1;
      if (turn === 1) {
        steer.requestTerminate(agentId);
        return toolUse("send_message", { to_agent_id: null, intent: "should not run" });
      }
      return toolUse("yield", {});
    },
    executeTool: async (call) => {
      executed.push(call.name);
      return { content: "{}", isError: false, audit: {} };
    },
    steer,
    logResponse: async () => {},
    logToolResult: async () => {},
  });

  assert.equal(turn, 1);
  assert.deepEqual(executed, []);
  assert.equal(steer.isTerminate(agentId), false);
});

test("steer_reasoning terminate mid-batch blocks remaining domain tools", async () => {
  const steer = new SteerQueue();
  const agentId = "agent-terminate-batch";
  const executed: string[] = [];

  await runReasoningLoop({
    agentId,
    lane: "reasoning",
    wake: new Wake(roomyWakeLimits),
    assemble: async () => ({ system: "sys", messages: [], tools: [], throughSeq: 0 }),
    arrivalsSince: (afterSeq) => ({ turn: null, throughSeq: afterSeq }),
    call: async () => ({
      provider: "anthropic",
      content: [
        { type: "tool_use", id: "a", name: "send_message", input: { to_agent_id: null, intent: "one" } },
        { type: "tool_use", id: "b", name: "send_message", input: { to_agent_id: null, intent: "two" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
    executeTool: async (call) => {
      executed.push(call.name);
      steer.requestTerminate(agentId);
      return { content: "{}", isError: false, audit: {} };
    },
    steer,
    logResponse: async () => {},
    logToolResult: async () => {},
  });

  assert.deepEqual(executed, ["send_message"]);
  assert.equal(steer.isTerminate(agentId), false);
});

test("steer_reasoning accepts terminate without instruction", async () => {
  const locks = new LaneLocks();
  const steer = new SteerQueue();
  const agentId = "00000000-0000-4000-8000-0000000000ff";
  const result = await executeTool(
    {
      db: {} as never,
      callerId: agentId,
      callerKind: "agent",
      lane: "conversation",
      steer,
      intents: new IntentQueue(),
      locks,
      transcript: new TranscriptStore(),
      sessions: new HostSessions(),
      toolDebounce: noDebounce,
      enqueueConversation: () => {},
      enqueueReasoning: () => {},
    },
    {
      type: "tool_use",
      id: "t1",
      name: STEER_REASONING,
      input: { terminate: true },
    },
  );
  assert.equal(result.isError, false);
  assert.equal(steer.isTerminate(agentId), true);
  assert.equal(steer.hasItems(agentId), false);
});
