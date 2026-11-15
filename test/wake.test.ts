import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DwarChatRequest,
  DwarChatResponse,
  DwarMessage,
  DwarResponseBlock,
} from "../src/types/domain.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { IMPLICIT_WAIT_MINUTES, runAgentLoop } from "../src/runtime/loop.js";
import type { StepDeps } from "../src/runtime/step.js";
import { CAPPED_TURN, CLEARED_PREFIX, CONTINUE_TURN, OVERSIZED_PREFIX, SUPERSEDED_RESULT, TRIMMED_TURN, Wake, WakeStore } from "../src/runtime/wake.js";
import { roomyWakeLimits, loopHooks } from "./helpers.js";

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

const ASK: DwarMessage = { role: "user", content: "[From: Ankur]\ncheck my email" };

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
  wake: Wake,
  model: (request: DwarChatRequest) => DwarChatResponse,
  requests: DwarChatRequest[],
): StepDeps & { transcript: TranscriptStore } {
  return {
    transcript: new TranscriptStore(),
    agentId: "agent-1",
    wake,
    toolChoice: "auto",
    tagTurns: true,
    assemble: async () => ({
      system: "sys",
      tools: [],
      thread: [ASK],
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

test("under its budget, the agent keeps every full tool result and its own thinking for the whole wake", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runAgentLoop({
    ...loopHooks(),
    ...stepDeps(new Wake(roomyWakeLimits), () => {
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
  await runAgentLoop({
    ...loopHooks(),
    ...stepDeps(new Wake({ ...roomyWakeLimits, toolResultsMaxChars: 10_000, toolResultsKeptChars: 4_000, supersedeWindowTurns: 8 }),
      () => {
        n += 1;
        return n <= 12
          ? turn("anthropic", [call("browser_accessibility_tree", `s${n}`)])
          : turn("anthropic", [call("yield", "y")]);
      },
      requests,
    ),
  });

  const results = toolResults(requests.at(-1)!.messages);
  assert.equal(results.length, 12);
  assert.ok(results.slice(0, 10).every((result) => result.startsWith(CLEARED_PREFIX)));
  assert.match(results[0]!, /Saved at \/files\/results\/\S+\.txt: read_file it/);
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
  await runAgentLoop({
    ...loopHooks(),
    ...stepDeps(new Wake(roomyWakeLimits), () => {
      n += 1;
      return turn("anthropic", [call(n < 3 ? "modify_agent_prompt" : "yield", `m${n}`)]);
    }, requests),
    assemble: async () => {
      systems += 1;
      return {
        system: `sys v${systems}`,
        tools: [],
        thread: [ASK],
        throughSeq: 1,
      };
    },
  });

  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.system === "sys v1"));
});

test("only the transcript's last turn carries the cache breakpoint", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runAgentLoop({
    ...loopHooks(),
    ...stepDeps(new Wake(roomyWakeLimits), () => {
      n += 1;
      return turn("anthropic", [call(n < 3 ? "browser_navigate" : "yield", `b${n}`)]);
    }, requests),
  });

  for (const request of requests) {
    const marked = request.messages.flatMap((message, index) => (message.cache_breakpoint ? [index] : []));
    assert.deepEqual(marked, [0]);
  }
});

test("a turn without a tool call continues the run; only yield ends it", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runAgentLoop({
    ...loopHooks(),
    ...stepDeps(new Wake(roomyWakeLimits), () => {
      n += 1;
      if (n === 1) {
        return turn("anthropic", [
          { type: "thinking", thinking: "browser 15 is down", signature: "s" },
          { type: "text", text: "Browser 15 is not running; I should report that." },
        ]);
      }
      return turn("anthropic", [call("yield", "y")]);
    }, requests),
  });

  assert.equal(requests.length, 2);
  const second = requests[1]!.messages;
  assert.equal(second.at(-2)?.role, "assistant");
  assert.deepEqual(second.at(-1), { role: "user", content: CONTINUE_TURN });
});

test("an empty turn or a provider error with no tool call fails the run instead of looping", async () => {
  for (const response of [
    turn("anthropic", []),
    { ...turn("anthropic", [{ type: "text", text: "refused" }]), stop_reason: "error" as const },
  ]) {
    await assert.rejects(
      runAgentLoop({
    ...loopHooks(),
        ...stepDeps(new Wake(roomyWakeLimits), () => response, []),
      }),
    );
  }
});

test("a turn that runs out of room while thinking is told to write its plan down and act, and three in a row stop the run", async () => {
  const capped = { ...turn("anthropic", [{ type: "thinking", thinking: "laying out the week", signature: "sig" }]), stop_reason: "max_tokens" as const };
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runAgentLoop({
    ...loopHooks(),
    ...stepDeps(new Wake(roomyWakeLimits), () => {
      n += 1;
      return n === 1 ? capped : turn("anthropic", [call("yield", "y")]);
    }, requests),
  });
  assert.ok(JSON.stringify(requests[1]!.messages).includes(CAPPED_TURN));

  await assert.rejects(
    runAgentLoop({ ...loopHooks(), ...stepDeps(new Wake(roomyWakeLimits), () => capped, []) }),
    /ran out of output room while thinking 3 turns in a row/,
  );
});

test("an empty turn is asked again once, and the retry's answer is the step", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runAgentLoop({
    ...loopHooks(),
    ...stepDeps(new Wake(roomyWakeLimits), () => {
      n += 1;
      return n === 1 ? turn("anthropic", []) : turn("anthropic", [call("yield", "y")]);
    }, requests),
  });
  assert.equal(requests.length, 2);
});

test("a turn of text and no tool call is the agent's answer when it is taken, and only thought when it is not", async () => {
  const taken: string[] = [];
  const requests: DwarChatRequest[] = [];
  await runAgentLoop({
    ...loopHooks(),
    ...stepDeps(new Wake(roomyWakeLimits), () => turn("anthropic", [{ type: "text", text: "HW3 is due Wed Nov 11." }]), requests),
    replyWithText: async (text) => {
      taken.push(text);
      return true;
    },
  });
  assert.deepEqual(taken, ["HW3 is due Wed Nov 11."]);
  assert.equal(requests.length, 1, "a taken answer ends the run");

  const thoughts: DwarChatRequest[] = [];
  let n = 0;
  await runAgentLoop({
    ...loopHooks(),
    ...stepDeps(new Wake(roomyWakeLimits), () => {
      n += 1;
      return n === 1 ? turn("anthropic", [{ type: "text", text: "thinking aloud" }]) : turn("anthropic", [call("yield", "y1")]);
    }, thoughts),
    replyWithText: async () => false,
  });
  assert.equal(thoughts.length, 2, "text that is only thought continues the run");
});

test("text beside a lone yield is the answer when nothing is pending, and only thought when something is or the call is not a yield", async () => {
  async function run(content: DwarChatResponse["content"], pending: boolean): Promise<{ taken: string[] }> {
    const taken: string[] = [];
    const requests: DwarChatRequest[] = [];
    await runAgentLoop({
      ...loopHooks(),
      ...stepDeps(new Wake(roomyWakeLimits), () => turn("anthropic", content), requests),
      replyWithText: async (text) => {
        taken.push(text);
        return true;
      },
      hasPending: async () => pending,
    });
    return { taken };
  }
  const answer: DwarChatResponse["content"] = [{ type: "text", text: "Stored: coffee is off." }, call("yield", "y1")];

  assert.deepEqual((await run(answer, false)).taken, ["Stored: coffee is off."]);
  assert.deepEqual((await run(answer, true)).taken, [], "an ask or helper is pending, so the text is narration");
  assert.deepEqual((await run([{ type: "text", text: "looking" }, call("recall_memory", "r1"), call("yield", "y2")], false)).taken, [], "another tool in the turn");
  assert.deepEqual((await run([call("yield", "y3")], false)).taken, [], "no text");
});

test("a wake lives while any run holds it and is dropped when the last releases", () => {
  const wakes = new WakeStore(roomyWakeLimits);
  const first = wakes.hold("agent-1");
  const wake = wakes.get("agent-1");
  wake.begin("sys", frozen("hi"), 1);
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

test("a queued run makes no model call until something joins the wake", async () => {
  const wake = new Wake(roomyWakeLimits);
  const requests: DwarChatRequest[] = [];
  let arrival: DwarMessage | null = null;
  const deps = {
    ...loopHooks(),
    ...stepDeps(wake, () => turn("anthropic", [call("yield", `y${requests.length}`)]), requests),
    arrivalsSince: (afterSeq: number) => {
      const next = arrival;
      arrival = null;
      return next === null ? { turn: null, throughSeq: afterSeq } : { turn: next, throughSeq: afterSeq + 1 };
    },
  };

  await runAgentLoop(deps);
  assert.equal(requests.length, 1);

  await runAgentLoop(deps);
  assert.equal(requests.length, 1, "nothing new since the yield");

  arrival = { role: "user", content: "[Arrived during this wake]\n\n[From: Ankur]\nany update?" };
  await runAgentLoop(deps);
  assert.equal(requests.length, 2);
});

/** The thread frozen as one user message of `content`. */
function frozen(content: string): DwarMessage[] {
  return [{ role: "user", content }];
}

/** Push one step onto `wake`: a call to `id`, then its result of `chars` characters under `state`. */
function pushRead(wake: Wake, id: string, state?: string, chars = 1_000): void {
  wake.push(
    { message: { role: "assistant", content: [call("browser_accessibility_tree", id)] } },
    {
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: `${id} `.padEnd(chars, "x"), is_error: false }],
      },
      ...(state !== undefined ? { states: { [id]: state } } : {}),
    },
  );
}

test("a newer read of the same state replaces the older one within the window at the next cut, never before; other states stay", () => {
  const wake = new Wake({ ...roomyWakeLimits, toolResultsMaxChars: 1_000_000, toolResultsKeptChars: 500_000, supersedeWindowTurns: 4, promptCeilingTokens: 3_800, promptTrimTokens: 400 });
  wake.begin("sys", frozen("[From: Ankur]\ncheck the course page"), 1);
  pushRead(wake, "t1", "browser:1:tree:tab");
  pushRead(wake, "x1", "browser:1:text:https://a.example/");
  pushRead(wake, "t2", "browser:1:tree:tab");
  pushRead(wake, "x2", "browser:1:text:https://b.example/");
  pushRead(wake, "s1");
  pushRead(wake, "s2");
  pushRead(wake, "x3", "browser:1:text:https://a.example/");
  assert.ok(toolResults(wake.view()).every((result) => result !== SUPERSEDED_RESULT), "no replacement before a cut");

  wake.fit([]);
  const results = toolResults(wake.view());
  assert.equal(results[0], SUPERSEDED_RESULT);
  assert.ok(results[1]!.startsWith("x1 "), "a.example's text is too far back to replace");
  assert.ok(results[2]!.startsWith("t2 "));
  assert.ok(results[3]!.startsWith("x2 "), "another page's text is not stale");
  assert.ok(results.slice(4).every((result) => result !== SUPERSEDED_RESULT));
});

test("at the clearing budget the queued older reads are replaced first, and clearing waits while that is enough", () => {
  const wake = new Wake({ ...roomyWakeLimits, toolResultsMaxChars: 3_000, toolResultsKeptChars: 1_500, supersedeWindowTurns: 8 });
  wake.begin("sys", frozen("[From: Ankur]\nwatch the terminal"), 1);
  for (let i = 1; i <= 5; i += 1) {
    pushRead(wake, `r${i}`, "terminal:t1");
  }
  const results = toolResults(wake.view());
  assert.deepEqual(results.slice(0, 3), Array(3).fill(SUPERSEDED_RESULT), "r4 passed the budget: the reads queued by then were the cut");
  assert.ok(results[3]!.startsWith("r4 "), "r4 was queued after that cut and waits for the next");
  assert.ok(results[4]!.startsWith("r5 "));
  assert.ok(!results.some((result) => result.startsWith(CLEARED_PREFIX)));
});

test("a tool result's state reaches the wake through the step loop", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runAgentLoop({
    ...loopHooks(),
    ...stepDeps(new Wake({ ...roomyWakeLimits, toolResultsMaxChars: 800, toolResultsKeptChars: 400 }), () => {
      n += 1;
      return n <= 3
        ? turn("anthropic", [call("browser_accessibility_tree", `t${n}`)])
        : turn("anthropic", [call("yield", "y")]);
    }, requests),
    executeTool: async (use) => ({
      content: `tree from ${use.id}`.padEnd(300, "x"),
      isError: false,
      audit: {},
      state: "browser:1:tree:tab",
    }),
  });
  assert.deepEqual(toolResults(requests.at(-1)!.messages), [
    SUPERSEDED_RESULT,
    SUPERSEDED_RESULT,
    "tree from t3".padEnd(300, "x"),
  ]);
});

/** Push one step onto `wake` that cost `outputTokens` to write, with a short result. */
function pushStep(wake: Wake, id: string, outputTokens: number): void {
  wake.push(
    { message: { role: "assistant", content: [call("terminal_read", id)], provider: "anthropic" }, outputTokens },
    { message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `${id} `.padEnd(30, "x"), is_error: false }] } },
  );
}

/** The tool_use ids a view still carries, in order. */
function callIds(messages: DwarMessage[]): string[] {
  return messages.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.flatMap((block) => (block.type === "tool_use" ? [block.id] : [])),
  );
}

/** Wake limits with a 1000-token prompt ceiling that trims to 600, for tests about trimming. */
const ceilingLimits = { ...roomyWakeLimits, promptCeilingTokens: 1_000, promptTrimTokens: 400 };

test("past its ceiling the agent drops its oldest steps in one jump behind a trimmed note", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nwatch the terminal"), 1);
  for (let i = 1; i <= 6; i += 1) {
    pushStep(wake, `s${i}`, 140);
  }
  wake.fit([]);
  assert.deepEqual(callIds(wake.view()), ["s1", "s2", "s3", "s4", "s5", "s6"]);

  pushStep(wake, "s7", 140);
  wake.fit([]);
  const trimmed = wake.view();
  assert.deepEqual(callIds(trimmed), ["s5", "s6", "s7"]);
  assert.equal(trimmed[1]!.content, TRIMMED_TURN);
  assert.equal(trimmed[2]!.role, "assistant");

  pushStep(wake, "s8", 140);
  wake.fit([]);
  const next = wake.view();
  assert.deepEqual(next.slice(0, trimmed.length), trimmed, "the trimmed prefix holds until the next trim");
});

/** Push one step onto `wake` whose model turn thought `thought` characters and cost `outputTokens`. */
function pushThoughtStep(wake: Wake, id: string, thought: number, outputTokens: number): void {
  wake.push(
    {
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "t".repeat(thought), signature: "sig" }, call("terminal_read", id)],
        provider: "anthropic",
      },
      outputTokens,
    },
    { message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `${id} `.padEnd(30, "x"), is_error: false }] } },
  );
}

/** How many model turns in a view still carry thinking. */
function thoughtTurns(messages: DwarMessage[]): number {
  return messages.filter(
    (message) => typeof message.content !== "string" && message.content.some((block) => block.type === "thinking"),
  ).length;
}

test("past its ceiling the agent drops older thinking before any step, keeping the newest turn's", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nrebuild the resume"), 1);
  for (let i = 1; i <= 4; i += 1) {
    pushThoughtStep(wake, `s${i}`, 460, 200);
  }
  wake.fit([]);
  assert.equal(thoughtTurns(wake.view()), 4);

  pushThoughtStep(wake, "s5", 460, 200);
  wake.fit([]);
  const view = wake.view();
  assert.deepEqual(callIds(view), ["s1", "s2", "s3", "s4", "s5"]);
  assert.equal(thoughtTurns(view), 1);
  assert.equal((view.at(-2)!.content as DwarResponseBlock[])[0]!.type, "thinking");

  pushThoughtStep(wake, "s6", 460, 200);
  wake.fit([]);
  const next = wake.view();
  assert.deepEqual(next.slice(0, view.length - 2), view.slice(0, -2), "the thought-free prefix holds until the next cut");
  assert.equal(thoughtTurns(next), 2);
});

test("a turn that thought weighs what its provider billed, not its shorter visible thinking", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nplan the week"), 1);
  pushThoughtStep(wake, "s1", 460, 2_000);
  assert.throws(() => wake.fit([]), /over the 1000-token ceiling/, "billed thinking past the ceiling never goes out under it");
});

test("the measured prompt, not its estimate, decides when it trims", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nwatch the terminal"), 1);
  pushStep(wake, "s1", 100);
  wake.fit([]);
  wake.measure({ ...usage, input_tokens: 4, cache_read_input_tokens: 800 });

  pushStep(wake, "s2", 100);
  wake.fit([]);
  assert.deepEqual(callIds(wake.view()), ["s1", "s2"]);

  pushStep(wake, "s3", 150);
  wake.fit([]);
  assert.deepEqual(callIds(wake.view()), ["s3"]);
});

test("a newest step that alone passes the ceiling fails the run instead of going out", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nwatch the terminal"), 1);
  pushStep(wake, "s1", 100);
  pushStep(wake, "s2", 2_000);
  assert.throws(() => wake.fit([]), /over the 1000-token ceiling/);
});

test("a newest step whose results alone pass the ceiling drops its largest results, only as many as it must, instead of failing", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nsearch my logs"), 1);
  wake.push(
    {
      message: { role: "assistant", content: [call("get_logs", "g1"), call("get_logs", "g2"), call("recall_memory", "r1")], provider: "anthropic" },
      outputTokens: 50,
    },
    {
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "g1", content: "a".repeat(1_500), is_error: false },
          { type: "tool_result", tool_use_id: "g2", content: "b".repeat(1_200), is_error: false },
          { type: "tool_result", tool_use_id: "r1", content: "small recall", is_error: false },
        ],
      },
    },
  );
  wake.fit([]);
  const results = toolResults(wake.view());
  assert.ok(results[0]!.startsWith(OVERSIZED_PREFIX));
  assert.match(results[0]!, /get_logs \{\} · 1500 chars, too large for the prompt\. Saved at \/files\/results\/g1\.txt: read_file it/);
  assert.equal(results[1], "b".repeat(1_200));
  assert.equal(results[2], "small recall");
  assert.ok(toolResults(wake.view())[0]!.startsWith(OVERSIZED_PREFIX));
});

/** Push one step onto `wake` that says `text` and calls `name` as `id`, with `result`. */
function pushAction(wake: Wake, id: string, name: string, text: string, result: string, outputTokens = 1): void {
  wake.push(
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text }, { type: "tool_use", id, name, input: { ref: id } }],
        provider: "anthropic",
      },
      outputTokens,
    },
    { message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: false }] } },
  );
}

test("a trimmed note lists the actions of the steps it dropped, so the agent does not redo them", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nsend the invites"), 1);
  pushAction(wake, "a1", "steer_browser", "Clicking Send on Luke's invite.", '{"clicked":true}', 140);
  for (let i = 2; i <= 7; i += 1) {
    pushStep(wake, `s${i}`, 140);
  }
  wake.fit([]);
  const view = wake.view();
  assert.ok(!callIds(view).includes("a1"), "the action's step left the view");
  const note = view[1]!.content;
  assert.ok(typeof note === "string" && note.startsWith(TRIMMED_TURN));
  assert.match(note, /Luke's invite\.\n {2}steer_browser/);
});

test("lastHold is true only while exactly one run holds the wake", () => {
  const wakes = new WakeStore(roomyWakeLimits);
  assert.equal(wakes.lastHold("agent-1"), false);
  const first = wakes.hold("agent-1");
  const second = wakes.hold("agent-1");
  assert.equal(wakes.lastHold("agent-1"), false);
  first();
  assert.equal(wakes.lastHold("agent-1"), true);
  second();
  assert.equal(wakes.lastHold("agent-1"), false);
});

test("the wake's reasons keep the order they arrived in, and a reason that arrives later is not added", () => {
  const wake = new Wake(roomyWakeLimits);
  wake.noteReason("helper result from task/browser/3");
  wake.noteReason("message from ankur");
  wake.noteReason("message from ankur");
  assert.deepEqual(wake.reasonList, ["helper result from task/browser/3", "message from ankur"]);
});

test("the wake header is the first turn after the transcript, and a wake with none has no first line", async () => {
  const requests: DwarChatRequest[] = [];
  const deps = stepDeps(new Wake(roomyWakeLimits), () => turn("anthropic", [call("yield", "y1")]), requests);
  await runAgentLoop({
    ...loopHooks(),
    ...deps,
    assemble: async () => ({ ...(await deps.assemble()), header: "[Wake] message from Ankur · job #7 (new)" }),
  });
  const texts = requests[0]!.messages.map((message) => (typeof message.content === "string" ? message.content : ""));
  assert.equal(texts.at(-1), "[Wake] message from Ankur · job #7 (new)");
  assert.equal(new Wake(roomyWakeLimits).reasonList.length, 0);
});

test("a continuation's earlier steps come before what arrived since, so the arrival that woke the agent is read last", async () => {
  const requests: DwarChatRequest[] = [];
  const deps = stepDeps(new Wake(roomyWakeLimits), () => turn("anthropic", [call("yield", "y1")]), requests);
  const steer: DwarMessage = { role: "assistant", content: [call("steer_browser", "s1")] };
  const result: DwarMessage = { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "{\"id\":\"task/browser/1\"}", is_error: false }] };
  await runAgentLoop({
    ...loopHooks(),
    ...deps,
    assemble: async () => ({
      ...(await deps.assemble()),
      header: "[Wake] helper result from task/browser/1",
      continued: [{ message: steer }, { message: result }],
      arrived: { role: "user", content: "[Arrived since your last step]\n[Notice from hath]\nHelper finished (task/browser/1)" },
    }),
  });
  const kinds = requests[0]!.messages.map((message) => (typeof message.content === "string" ? message.content.split("\n")[0] : message.content[0]!.type));
  assert.deepEqual(kinds, ["[From: Ankur]", "[Wake] helper result from task/browser/1", "tool_use", "tool_result", "[Arrived since your last step]"]);
});

test("a yield that leaves a request unanswered with nothing to wake the agent gets the reminder once", async () => {
  const requests: DwarChatRequest[] = [];
  let asked = 0;
  const reminder = "[continue] ankur asked \"x\" at t and nothing you started will wake you. Answer now, or start what will.";
  await runAgentLoop({
    ...loopHooks(),
    yieldReminder: async () => {
      asked += 1;
      return reminder;
    },
    ...stepDeps(new Wake(roomyWakeLimits), () => turn("anthropic", [call("yield", `y${requests.length}`)]), requests),
  });
  assert.equal(requests.length, 2, "the second yield stands");
  assert.equal(asked, 1, "the check runs for the first yield only");
  const last = requests[1]!.messages.at(-1)!;
  assert.equal(typeof last.content === "string" ? last.content : "", reminder);
});

test("a yield records what the run waits on before the reminder check, and a stopped run records nothing", async () => {
  const order: string[] = [];
  const requests: DwarChatRequest[] = [];
  await runAgentLoop({
    ...loopHooks(),
    watchPending: async (minutes) => {
      order.push(`watch ${minutes}`);
    },
    yieldReminder: async () => {
      order.push("reminder");
      return null;
    },
    ...stepDeps(new Wake(roomyWakeLimits), () => turn("anthropic", [call("yield", "y1")]), requests),
  });
  assert.deepEqual(order, [`watch ${IMPLICIT_WAIT_MINUTES}`, "reminder"]);

  const hooks = loopHooks();
  const stoppedWaits: number[] = [];
  await runAgentLoop({
    ...hooks,
    watchPending: async (minutes) => {
      stoppedWaits.push(minutes);
    },
    ...stepDeps(new Wake(roomyWakeLimits), () => {
      hooks.interrupts.stop("agent-1");
      return turn("anthropic", [call("yield", "y2")]);
    }, []),
  });
  assert.deepEqual(stoppedWaits, []);
});

/** A tool_use block with `input`. */
function use(name: string, id: string, input: unknown): DwarResponseBlock {
  return { type: "tool_use", id, name, input };
}

test("a turn of only sends and steers, with any saves, ends the run by itself; a store alone, or anything else, does not", async () => {
  const cases: Array<{ name: string; calls: Array<[string, unknown]>; failing?: string; ends: boolean }> = [
    { name: "result and saves", calls: [["write_file", {}], ["ingest_memory", {}], ["set_routine", {}], ["send_message", { to: "ankur", content: "Done.", status: "done" }]], ends: true },
    { name: "a steer", calls: [["steer_browser", { message: "read D2L" }]], ends: true },
    { name: "two steers and a message", calls: [["steer_browser", { message: "a" }], ["steer_terminal", { message: "b" }], ["send_message", { to: "ankur", content: "Reading." }]], ends: true },
    { name: "an ingest alone", calls: [["ingest_memory", { text: "x" }]], ends: false },
    { name: "an ingest beside a message", calls: [["ingest_memory", { text: "x" }], ["send_message", { to: "ankur", content: "Stored." }]], ends: true },
    { name: "a stop and its report", calls: [["stop_task", { id: "task/browser/3" }], ["send_message", { to: "requester", content: "Stopped.", status: "done" }]], ends: true },
    { name: "failed save", calls: [["edit_file", {}], ["send_message", { to: "ankur", content: "Done." }]], failing: "edit_file", ends: false },
    { name: "saves alone", calls: [["write_file", {}]], ends: false },
    { name: "a read beside the message", calls: [["read_file", {}], ["send_message", { to: "ankur", content: "Done." }]], ends: false },
    { name: "a read beside a steer", calls: [["read_file", {}], ["steer_browser", { message: "read D2L" }]], ends: false },
    { name: "a failed steer", calls: [["steer_browser", { message: "read D2L" }]], failing: "steer_browser", ends: false },
  ];
  for (const { name, calls, failing, ends } of cases) {
    const requests: DwarChatRequest[] = [];
    const waits: number[] = [];
    let n = 0;
    await runAgentLoop({
      ...loopHooks(),
      ...stepDeps(new Wake(roomyWakeLimits), () => {
        n += 1;
        return n === 1 ? turn("anthropic", calls.map(([tool, input], i) => use(tool, `c${i}`, input))) : turn("anthropic", [call("yield", `y${n}`)]);
      }, requests),
      executeTool: async (block) => ({
        content: JSON.stringify({ id: "task/browser/3", to_agent_id: null, ask: false }),
        isError: block.name === failing,
        audit: {},
      }),
      watchPending: async (minutes) => {
        waits.push(minutes);
      },
    });
    assert.equal(requests.length, ends ? 1 : 2, name);
    assert.deepEqual(waits, [IMPLICIT_WAIT_MINUTES], `${name}: the run ends once and records what it waits on once`);
  }
});

/** A model call that stays out until its signal aborts, as a request cancelled in flight does. */
function hangingCall(requests: DwarChatRequest[], answer: () => DwarChatResponse) {
  return async (request: DwarChatRequest, signal?: AbortSignal): Promise<DwarChatResponse> => {
    requests.push(structuredClone(request));
    if (requests.length > 1) {
      return answer();
    }
    return new Promise((_, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("request cancelled")), { once: true });
    });
  };
}

test("preempting the model call in flight cancels it within a second, and the step runs again with the arrival in view", async () => {
  const hooks = loopHooks();
  const requests: DwarChatRequest[] = [];
  const aborted: string[] = [];
  let arrival: DwarMessage | null = null;
  const deps = {
    ...hooks,
    ...stepDeps(new Wake(roomyWakeLimits), () => turn("anthropic", [call("yield", "y")]), requests),
    call: hangingCall(requests, () => turn("anthropic", [call("yield", "y")])),
    arrivalsSince: (afterSeq: number) => {
      const next = arrival;
      arrival = null;
      return next === null ? { turn: null, throughSeq: afterSeq } : { turn: next, throughSeq: afterSeq + 1 };
    },
    logAborted: async () => {
      aborted.push("aborted");
    },
  };
  const started = Date.now();
  const running = runAgentLoop(deps);
  await new Promise((resolve) => setTimeout(resolve, 20));
  arrival = { role: "user", content: "[Arrived during this wake]\n\n[From: Ankur · job #7]\nstop, only the exams" };
  assert.equal(hooks.interrupts.preempt("agent-1"), true);
  assert.equal(hooks.interrupts.preempt("agent-1"), false, "one cancel per arrival: the stretch is already aborted");
  await running;

  assert.ok(Date.now() - started < 1_000);
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]!.messages.at(-1)), /only the exams/);
  assert.deepEqual(aborted, ["aborted"]);
});

test("a stop ends the run within a second: the call in flight is cancelled and later calls in the turn do not run", async () => {
  const hooks = loopHooks();
  const requests: DwarChatRequest[] = [];
  const started = Date.now();
  const running = runAgentLoop({
    ...hooks,
    ...stepDeps(new Wake(roomyWakeLimits), () => turn("anthropic", [call("yield", "y")]), requests),
    call: hangingCall(requests, () => turn("anthropic", [call("yield", "y")])),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hooks.interrupts.stop("agent-1"), true);
  await running;
  assert.ok(Date.now() - started < 1_000);
  assert.equal(requests.length, 1, "no further model call");
  assert.equal(hooks.interrupts.isStopped("agent-1"), false, "the stop ends with the run");

  const ran: string[] = [];
  const results: Array<[string, boolean]> = [];
  const second = loopHooks();
  await runAgentLoop({
    ...second,
    ...stepDeps(new Wake(roomyWakeLimits), () => turn("anthropic", [call("read_file", "a"), call("read_file", "b")]), []),
    executeTool: async (block) => {
      ran.push(block.id);
      second.interrupts.stop("agent-1");
      return { content: "{}", isError: false, audit: {} };
    },
    logToolResult: async (block, result) => {
      results.push([block.id, result.isError]);
    },
  });
  assert.deepEqual(ran, ["a"]);
  assert.deepEqual(results, [["a", false], ["b", true]]);
});

test("a stop of an agent whose loop is not running changes nothing", () => {
  const hooks = loopHooks();
  assert.equal(hooks.interrupts.stop("agent-1"), false);
  assert.equal(hooks.interrupts.preempt("agent-1"), false);
  assert.equal(hooks.interrupts.isStopped("agent-1"), false);
});

test("several ingest_memory calls in one turn make one request, and every call gets a result", async () => {
  const executed: Array<{ id: string; input: unknown }> = [];
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runAgentLoop({
    ...loopHooks(),
    ...stepDeps(new Wake(roomyWakeLimits), () => {
      n += 1;
      return n === 1
        ? turn("anthropic", [use("ingest_memory", "i1", { text: "CSE 300 quiz Nov 20" }), use("ingest_memory", "i2", { text: "CSE 335 HW due Nov 22", participant_ids: ["8a0f0f0e-0000-4000-8000-000000000001"] }), use("read_file", "r", {})])
        : turn("anthropic", [call("yield", "y")]);
    }, requests),
    executeTool: async (block) => {
      executed.push({ id: block.id, input: block.input });
      return { content: '{"counts":{"create_node":2}}', isError: false, audit: {} };
    },
  });
  assert.deepEqual(executed.filter((entry) => entry.id.startsWith("i")), [
    { id: "i1", input: { text: "CSE 300 quiz Nov 20\n\nCSE 335 HW due Nov 22", participant_ids: ["8a0f0f0e-0000-4000-8000-000000000001"] } },
  ]);
  const results = requests.at(-1)!.messages.flatMap((message) => (typeof message.content === "string" ? [] : message.content.filter((block) => block.type === "tool_result")));
  assert.deepEqual(results.map((block) => (block.type === "tool_result" ? block.tool_use_id : "")), ["i1", "i2", "r"]);
  assert.match(JSON.stringify(results[1]), /stored_with/);
});
