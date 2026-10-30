import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DwarChatRequest,
  DwarChatResponse,
  DwarMessage,
  DwarResponseBlock,
  Lane,
} from "../src/types/domain.js";
import type { Db } from "../src/db/client.js";
import { runProcessLoop, UNSENT_TEXT_TURN } from "../src/runtime/process.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { LONG_SILENCE_TURN, runWorkLoop, TURNS_BEFORE_NUDGE, UNSENT_REPORT_TURN } from "../src/runtime/work.js";
import type { StepDeps } from "../src/runtime/step.js";
import { SteerQueue, STEER_TURN_PREFIX } from "../src/runtime/steer.js";
import { CAPPED_TURN, CLEARED_PREFIX, CONTINUE_TURN, OVERSIZED_PREFIX, SUPERSEDED_RESULT, TRIMMED_TURN, Wake, WakeStore } from "../src/runtime/wake.js";
import { roomyWakeLimits, workLoopHooks } from "./helpers.js";

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
  lane: Lane,
  wake: Wake,
  model: (request: DwarChatRequest) => DwarChatResponse,
  requests: DwarChatRequest[],
): StepDeps & { transcript: TranscriptStore } {
  return {
    transcript: new TranscriptStore(),
    agentId: "agent-1",
    lane,
    wake,
    assemble: async () => ({
      system: "sys",
      tools: [],
      transcripts: { work: [ASK], process: [ASK] },
      throughSeq: 1,
    }),
    arrivalsSince: (afterSeq) => ({ turn: null, sent: null, throughSeq: afterSeq }),
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

test("under its budget, the work lane keeps every full tool result and its own thinking for the whole wake", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runWorkLoop({
    ...workLoopHooks,
    ...stepDeps("work", new Wake(roomyWakeLimits), () => {
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
    lane: "work",
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
  await runWorkLoop({
    ...workLoopHooks,
    ...stepDeps(
      "work",
      new Wake({ ...roomyWakeLimits, toolResultsMaxChars: 10_000, toolResultsKeptChars: 4_000, supersedeWindowTurns: 8 }),
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
  await runWorkLoop({
    ...workLoopHooks,
    ...stepDeps("work", new Wake(roomyWakeLimits), () => {
      n += 1;
      return turn("anthropic", [call(n < 3 ? "modify_agent_prompt" : "yield", `m${n}`)]);
    }, requests),
    assemble: async () => {
      systems += 1;
      return {
        system: `sys v${systems}`,
        tools: [],
        transcripts: { work: [ASK], process: [ASK] },
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
  await runWorkLoop({
    ...workLoopHooks,
    ...stepDeps("work", new Wake(roomyWakeLimits), () => {
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
  await runWorkLoop({
    ...workLoopHooks,
    ...stepDeps("work", new Wake(roomyWakeLimits), () => {
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
      runWorkLoop({
    ...workLoopHooks,
        ...stepDeps("work", new Wake(roomyWakeLimits), () => response, []),
        steer: new SteerQueue(),
      }),
    );
  }
});

test("a turn that runs out of room while thinking is told to write its plan down and act, and three in a row stop the lane", async () => {
  const capped = { ...turn("anthropic", [{ type: "thinking", thinking: "laying out the week", signature: "sig" }]), stop_reason: "max_tokens" as const };
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runWorkLoop({
    ...workLoopHooks,
    ...stepDeps("work", new Wake(roomyWakeLimits), () => {
      n += 1;
      return n === 1 ? capped : turn("anthropic", [call("yield", "y")]);
    }, requests),
    steer: new SteerQueue(),
  });
  assert.ok(JSON.stringify(requests[1]!.messages).includes(CAPPED_TURN));

  await assert.rejects(
    runWorkLoop({ ...workLoopHooks, ...stepDeps("work", new Wake(roomyWakeLimits), () => capped, []), steer: new SteerQueue() }),
    /ran out of output room while thinking 3 turns in a row/,
  );
});

test("an empty turn is asked again once, and the retry's answer is the step", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runWorkLoop({
    ...workLoopHooks,
    ...stepDeps("work", new Wake(roomyWakeLimits), () => {
      n += 1;
      return n === 1 ? turn("anthropic", []) : turn("anthropic", [call("yield", "y")]);
    }, requests),
    steer: new SteerQueue(),
  });
  assert.equal(requests.length, 2);
});

test("a process-lane turn still empty after its retry ends the run instead of failing the wake", async () => {
  const requests: DwarChatRequest[] = [];
  await runProcessLoop({
    ...stepDeps("process", new Wake(roomyWakeLimits), () => turn("anthropic", []), requests),
    ...processGateDeps(),
  });
  assert.equal(requests.length, 2);
});

test("the process lane's view leaves out the work lane's turns and ends on the status block; steers stay private to work", async () => {
  const wake = new Wake(roomyWakeLimits);
  const steer = new SteerQueue();
  const workRequests: DwarChatRequest[] = [];
  const processRequests: DwarChatRequest[] = [];

  steer.append("agent-1", "open Gmail and search newer_than:1d");
  let r = 0;
  await runWorkLoop({
    ...workLoopHooks,
    ...stepDeps("work", wake, () => {
      r += 1;
      if (r === 1) {
        return turn("anthropic", [
          { type: "thinking", thinking: "navigate first", signature: "sig" },
          call("browser_navigate", "nav-1"),
        ]);
      }
      return turn("anthropic", [call("yield", "r-y")]);
    }, workRequests),
    steer,
  });

  await runProcessLoop({
    ...stepDeps("process", wake, () => turn("gemini", [call("yield", "c-y")]), processRequests),
    ...processGateDeps(),
  });

  const messages = processRequests[0]!.messages;
  const seen = JSON.stringify(messages);
  assert.ok(!seen.includes("navigate first"));
  assert.ok(!seen.includes("browser_navigate"));
  assert.ok(!seen.includes("full result of nav-1"));
  assert.ok(!seen.includes(STEER_TURN_PREFIX));
  assert.deepEqual(messages.at(-1), { role: "user", content: "[Status] test block" });

  const workBlob = JSON.stringify(wake.view("work"));
  assert.ok(workBlob.includes(STEER_TURN_PREFIX));
  assert.ok(workBlob.includes("navigate first"));
  assert.ok(!workBlob.includes('"lane":"process"'));
});

test("a send to someone already messaged since this one was written is refused with what went out", async () => {
  const transcript = new TranscriptStore();
  transcript.append({ fromAgentId: null, toAgentId: "agent-1", content: "is HW3 in?" });
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runProcessLoop({
    ...stepDeps("process", new Wake(roomyWakeLimits), () => {
      n += 1;
      if (n === 1) {
        transcript.append({ fromAgentId: "agent-1", toAgentId: null, content: "HW3 is submitted." });
        return turn("gemini", [
          { type: "tool_use", id: "d1", name: "send", input: { to: "ankur", content: "Checking HW3 now." } },
          call("yield", "y1"),
        ]);
      }
      return turn("gemini", [call("yield", `y${n}`)]);
    }, requests),
    ...processGateDeps(),
    transcript,
  });
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]!.messages), /already sent Ankur a message after you wrote this one: \\"HW3 is submitted\.\\"/);
});

test("a yield after a message written as text and never sent gets one reminder, and the second yield stands", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  const list = "Here is your week, ranked: ".padEnd(600, "x");

  await runProcessLoop({
    ...stepDeps("process", new Wake(roomyWakeLimits), () => {
      n += 1;
      return turn("anthropic", [{ type: "text", text: list }, call("yield", `c${n}`)]);
    }, requests),
    ...processGateDeps(),
  });

  assert.equal(requests.length, 2);
  assert.ok(JSON.stringify(requests[1]!.messages).includes(UNSENT_TEXT_TURN));
});

test("a work-lane yield after a report written as text and never sent gets one reminder, and the second yield stands", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  const report = "HW3 is submitted and graded: ".padEnd(600, "x");
  await runWorkLoop({
    ...workLoopHooks,
    ...stepDeps("work", new Wake(roomyWakeLimits), () => {
      n += 1;
      return turn("anthropic", [{ type: "text", text: report }, call("yield", `y${n}`)]);
    }, requests),
    steer: new SteerQueue(),
  });
  assert.equal(requests.length, 2);
  assert.ok(JSON.stringify(requests[1]!.messages).includes(UNSENT_REPORT_TURN));
});

test("a work lane that reports nothing for TURNS_BEFORE_NUDGE turns is asked what it has once, then keeps working", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runWorkLoop({
    ...workLoopHooks,
    ...stepDeps("work", new Wake(roomyWakeLimits), () => {
      n += 1;
      return turn("anthropic", [call(n <= TURNS_BEFORE_NUDGE ? "terminal_grep" : "yield", `t${n}`)]);
    }, requests),
    steer: new SteerQueue(),
  });
  assert.equal(requests.length, TURNS_BEFORE_NUDGE + 1);
  assert.ok(!JSON.stringify(requests[TURNS_BEFORE_NUDGE - 1]!.messages).includes(LONG_SILENCE_TURN));
  assert.ok(JSON.stringify(requests[TURNS_BEFORE_NUDGE]!.messages).includes(LONG_SILENCE_TURN));
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

test("a queued process-lane run makes no model call until something it can see joins the wake", async () => {
  const wake = new Wake(roomyWakeLimits);
  const requests: DwarChatRequest[] = [];
  let arrival: DwarMessage | null = null;
  const deps = {
    ...stepDeps("process", wake, () => turn("gemini", [call("yield", `y${requests.length}`)]), requests),
    arrivalsSince: (afterSeq: number) => {
      const next = arrival;
      arrival = null;
      return next === null ? { turn: null, sent: null, throughSeq: afterSeq } : { turn: next, sent: null, throughSeq: afterSeq + 1 };
    },
    ...processGateDeps(),
  };

  await runProcessLoop(deps);
  assert.equal(requests.length, 1);

  await runProcessLoop(deps);
  wake.push({ message: { role: "user", content: "steer: look again" }, only: "work" });
  await runProcessLoop(deps);
  assert.equal(requests.length, 1);

  arrival = { role: "user", content: "[Arrived during this wake]\n\n[From: Ankur]\nany update?" };
  await runProcessLoop(deps);
  assert.equal(requests.length, 2);
});

/** A query chain that finds no rows however it is built, awaited like a drizzle select. */
const noRows: unknown = {
  from: () => noRows,
  where: () => noRows,
  orderBy: () => noRows,
  then: (resolve: (rows: unknown[]) => void) => resolve([]),
};

/** What the process lane reads: a db with no queued work-lane messages and nothing else a test send reaches, a status block, and an empty transcript. */
function processGateDeps() {
  return { db: { select: () => noRows } as unknown as Db, transcript: new TranscriptStore(), status: async () => "[Status] test block" };
}

/** Both lanes' transcripts frozen as one user message of `content`. */
function frozen(content: string): Record<"work" | "process", DwarMessage[]> {
  return { work: [{ role: "user", content }], process: [{ role: "user", content }] };
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
  const wake = new Wake({ ...roomyWakeLimits, toolResultsMaxChars: 1_000_000, toolResultsKeptChars: 500_000, supersedeWindowTurns: 4, promptCeilingTokens: 1_000, promptTrimTokens: 400 });
  wake.begin("sys", frozen("[From: Ankur]\ncheck the course page"), 1);
  pushRead(wake, "t1", "browser:1:tree:tab");
  pushRead(wake, "x1", "browser:1:text:https://a.example/");
  pushRead(wake, "t2", "browser:1:tree:tab");
  pushRead(wake, "x2", "browser:1:text:https://b.example/");
  pushRead(wake, "s1");
  pushRead(wake, "s2");
  pushRead(wake, "x3", "browser:1:text:https://a.example/");
  assert.ok(toolResults(wake.view("process")).every((result) => result !== SUPERSEDED_RESULT), "no replacement before a cut");

  wake.fit("work", []);
  const results = toolResults(wake.view("process"));
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
  const results = toolResults(wake.view("work"));
  assert.deepEqual(results.slice(0, 3), Array(3).fill(SUPERSEDED_RESULT), "r4 passed the budget: the reads queued by then were the cut");
  assert.ok(results[3]!.startsWith("r4 "), "r4 was queued after that cut and waits for the next");
  assert.ok(results[4]!.startsWith("r5 "));
  assert.ok(!results.some((result) => result.startsWith(CLEARED_PREFIX)));
});

test("a tool result's state reaches the wake through the step loop", async () => {
  const requests: DwarChatRequest[] = [];
  let n = 0;
  await runWorkLoop({
    ...workLoopHooks,
    ...stepDeps("work", new Wake({ ...roomyWakeLimits, toolResultsMaxChars: 800, toolResultsKeptChars: 400 }), () => {
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
    steer: new SteerQueue(),
  });
  assert.deepEqual(toolResults(requests.at(-1)!.messages), [
    SUPERSEDED_RESULT,
    SUPERSEDED_RESULT,
    "tree from t3".padEnd(300, "x"),
  ]);
});

/** Push one work-lane step onto `wake` that cost `outputTokens` to write, with a short result. */
function pushStep(wake: Wake, id: string, outputTokens: number): void {
  wake.push(
    { message: { role: "assistant", content: [call("terminal_read", id)], provider: "anthropic", lane: "work" }, outputTokens },
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

test("past its ceiling a lane drops its oldest steps in one jump behind a trimmed note, and the other lane keeps them", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nwatch the terminal"), 1);
  for (let i = 1; i <= 6; i += 1) {
    pushStep(wake, `s${i}`, 140);
  }
  wake.fit("work", []);
  assert.deepEqual(callIds(wake.view("work")), ["s1", "s2", "s3", "s4", "s5", "s6"]);

  pushStep(wake, "s7", 140);
  wake.fit("work", []);
  const trimmed = wake.view("work");
  assert.deepEqual(callIds(trimmed), ["s5", "s6", "s7"]);
  assert.equal(trimmed[1]!.content, TRIMMED_TURN);
  assert.equal(trimmed[2]!.role, "assistant");
  assert.deepEqual(callIds(wake.view("process")), ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);

  pushStep(wake, "s8", 140);
  wake.fit("work", []);
  const next = wake.view("work");
  assert.deepEqual(next.slice(0, trimmed.length), trimmed, "the trimmed prefix holds until the next trim");
});

/** Push one work-lane step onto `wake` whose model turn thought `thought` characters and cost `outputTokens`. */
function pushThoughtStep(wake: Wake, id: string, thought: number, outputTokens: number): void {
  wake.push(
    {
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "t".repeat(thought), signature: "sig" }, call("terminal_read", id)],
        provider: "anthropic",
        lane: "work",
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

test("past its ceiling a lane drops older thinking before any step, keeping the newest turn's", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nrebuild the resume"), 1);
  for (let i = 1; i <= 4; i += 1) {
    pushThoughtStep(wake, `s${i}`, 460, 200);
  }
  wake.fit("work", []);
  assert.equal(thoughtTurns(wake.view("work")), 4);

  pushThoughtStep(wake, "s5", 460, 200);
  wake.fit("work", []);
  const view = wake.view("work");
  assert.deepEqual(callIds(view), ["s1", "s2", "s3", "s4", "s5"]);
  assert.equal(thoughtTurns(view), 1);
  assert.equal((view.at(-2)!.content as DwarResponseBlock[])[0]!.type, "thinking");
  assert.equal(thoughtTurns(wake.view("process")), 5);

  pushThoughtStep(wake, "s6", 460, 200);
  wake.fit("work", []);
  const next = wake.view("work");
  assert.deepEqual(next.slice(0, view.length - 2), view.slice(0, -2), "the thought-free prefix holds until the next cut");
  assert.equal(thoughtTurns(next), 2);
});

test("a turn that thought weighs what its provider billed, not its shorter visible thinking", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nplan the week"), 1);
  pushThoughtStep(wake, "s1", 460, 2_000);
  assert.throws(() => wake.fit("work", []), /over the 1000-token ceiling/, "billed thinking past the ceiling never goes out under it");
});

test("a lane's measured prompt, not its estimate, decides when it trims", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nwatch the terminal"), 1);
  pushStep(wake, "s1", 100);
  wake.fit("work", []);
  wake.measure("work", { ...usage, input_tokens: 4, cache_read_input_tokens: 800 });

  pushStep(wake, "s2", 100);
  wake.fit("work", []);
  assert.deepEqual(callIds(wake.view("work")), ["s1", "s2"]);

  pushStep(wake, "s3", 150);
  wake.fit("work", []);
  assert.deepEqual(callIds(wake.view("work")), ["s3"]);
});

test("a newest step that alone passes the ceiling fails the lane instead of going out", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nwatch the terminal"), 1);
  pushStep(wake, "s1", 100);
  pushStep(wake, "s2", 2_000);
  assert.throws(() => wake.fit("work", []), /over the 1000-token ceiling/);
});

test("a newest step whose results alone pass the ceiling drops its largest results, only as many as it must, instead of failing", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nsearch my logs"), 1);
  wake.push(
    {
      message: { role: "assistant", content: [call("get_logs", "g1"), call("get_logs", "g2"), call("recall_memory", "r1")], provider: "anthropic", lane: "work" },
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
  wake.fit("work", []);
  const results = toolResults(wake.view("work"));
  assert.ok(results[0]!.startsWith(OVERSIZED_PREFIX));
  assert.match(results[0]!, /get_logs \{\} · 1500 chars, too large for the prompt\. Saved at \/files\/results\/g1\.txt: read_file it/);
  assert.equal(results[1], "b".repeat(1_200));
  assert.equal(results[2], "small recall");
  assert.ok(toolResults(wake.view("process"))[0]!.startsWith(OVERSIZED_PREFIX));
});

/** Push one work-lane step onto `wake` that says `text` and calls `name` as `id`, with `result`. */
function pushAction(wake: Wake, id: string, name: string, text: string, result: string, outputTokens = 1): void {
  wake.push(
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text }, { type: "tool_use", id, name, input: { ref: id } }],
        provider: "anthropic",
        lane: "work",
      },
      outputTokens,
    },
    { message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: false }] } },
  );
}

test("a trimmed note lists the actions of the steps it dropped, so the lane does not redo them", () => {
  const wake = new Wake(ceilingLimits);
  wake.begin("sys", frozen("[From: Ankur]\nsend the invites"), 1);
  pushAction(wake, "a1", "steer_browser", "Clicking Send on Luke's invite.", '{"clicked":true}', 140);
  for (let i = 2; i <= 7; i += 1) {
    pushStep(wake, `s${i}`, 140);
  }
  wake.fit("work", []);
  const view = wake.view("work");
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

test("the wake's first line says what woke the agent, and a reason that arrives later is not added", async () => {
  const wake = new Wake(roomyWakeLimits);
  wake.noteReason("helper result from task/browser/3");
  wake.noteReason("message from ankur");
  wake.noteReason("message from ankur");
  const requests: DwarChatRequest[] = [];
  await runWorkLoop({
    ...workLoopHooks,
    ...stepDeps("work", wake, () => turn("anthropic", [call("yield", "y1")]), requests),
    steer: new SteerQueue(),
  });
  assert.equal(requests.length, 1);
  const texts = requests[0]!.messages.map((message) => (typeof message.content === "string" ? message.content : ""));
  assert.equal(texts.at(-1), "Woken by: helper result from task/browser/3; message from ankur");
  wake.noteReason("scheduled message from x");
  assert.equal(wake.wokenBy, "Woken by: helper result from task/browser/3; message from ankur");
});

test("a wake nobody gave a reason has no Woken by line", () => {
  assert.equal(new Wake(roomyWakeLimits).wokenBy, null);
});

test("a yield that leaves a request unanswered with nothing to wake the agent gets the reminder once", async () => {
  const requests: DwarChatRequest[] = [];
  let asked = 0;
  const reminder = "[continue] ankur asked \"x\" at t and nothing you started will wake you. Answer now, or start or wait on what will.";
  await runWorkLoop({
    ...workLoopHooks,
    yieldReminder: async () => {
      asked += 1;
      return reminder;
    },
    ...stepDeps("work", new Wake(roomyWakeLimits), () => turn("anthropic", [call("yield", `y${requests.length}`)]), requests),
    steer: new SteerQueue(),
  });
  assert.equal(requests.length, 2, "the second yield stands");
  assert.equal(asked, 1, "the check runs for the first yield only");
  const last = requests[1]!.messages.at(-1)!;
  assert.equal(typeof last.content === "string" ? last.content : "", reminder);
});

test("a wait with a target ends the run like a yield, and a refused wait does not", async () => {
  for (const [isError, calls] of [[false, 1], [true, 2]] as const) {
    const requests: DwarChatRequest[] = [];
    let n = 0;
    await runWorkLoop({
      ...workLoopHooks,
      ...stepDeps("work", new Wake(roomyWakeLimits), () => turn("anthropic", [call(n++ === 0 ? "wait" : "yield", `w${n}`)]), requests),
      executeTool: async (use) => ({ content: use.name === "wait" && isError ? "no agent x" : "{}", isError: use.name === "wait" && isError, audit: {} }),
      steer: new SteerQueue(),
    });
    assert.equal(requests.length, calls);
  }
});
