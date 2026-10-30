import assert from "node:assert/strict";
import { test } from "node:test";
import { listBrowsers, listTerminals, parseTaskAddress, steerBrowser, steerTerminal } from "../src/tools/helper/tasks.js";
import type { ToolContext } from "../src/tools/shared.js";
import { mockNas } from "./helpers.js";

function ctxFor(nas: ReturnType<typeof mockNas>, callerId: string | null = "networking-specialist") {
  const emitted: unknown[] = [];
  const ctx = { nas, callerId, events: { emit: (event: unknown) => emitted.push(event) } } as unknown as ToolContext;
  return { ctx, emitted };
}

test("steer_browser with no id starts a task and returns its address at once", async () => {
  const nas = mockNas();
  const { ctx, emitted } = ctxFor(nas);
  const result = await steerBrowser.handler(ctx, { message: "sign in to LinkedIn and read my inbox" });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content), { id: "task/browser/1" });
  assert.deepEqual(nas.startTaskCalls, [
    { kind: "browser", body: { agent_id: "networking-specialist", message: "sign in to LinkedIn and read my inbox" } },
  ]);
  assert.equal(emitted.length, 1, "the UI is told the sessions changed");
});

test("steer_browser with an id, short or whole, steers that task and nothing else", async () => {
  const nas = mockNas();
  const { ctx } = ctxFor(nas);
  await steerBrowser.handler(ctx, { message: "start" });
  for (const id of ["1", "task/browser/1"]) {
    const result = await steerBrowser.handler(ctx, { id, message: "the code is 123456" });
    assert.deepEqual(JSON.parse(result.content), { id: "task/browser/1" });
  }
  assert.equal(nas.startTaskCalls.length, 1);
  assert.deepEqual(nas.steerTaskCalls.map((call) => [call.kind, call.id]), [["browser", "1"], ["browser", "1"]]);
});

test("steer_browser refuses a terminal task's id, and an unknown task is a tool error from Nas", async () => {
  const nas = mockNas();
  const { ctx } = ctxFor(nas);
  const wrong = await steerBrowser.handler(ctx, { id: "task/terminal/4", message: "x" });
  assert.equal(wrong.isError, true);
  assert.equal(nas.steerTaskCalls.length, 0);
  await assert.rejects(steerBrowser.handler(ctx, { id: "99", message: "x" }), /no task browser\/99/);
});

test("steer_terminal passes its workdir to Nas as the starting directory", async () => {
  const nas = mockNas();
  const { ctx } = ctxFor(nas);
  await steerTerminal.handler(ctx, { message: "run the tests", workdir: "/var/home/dadi/repo" });
  assert.deepEqual(nas.startTaskCalls[0], {
    kind: "terminal",
    body: { agent_id: "networking-specialist", message: "run the tests", cwd: "/var/home/dadi/repo" },
  });
  assert.equal(steerTerminal.input.safeParse({ message: "x", workdir: "relative" }).success, false);
});

test("the steer tools need an agent identity", async () => {
  const { ctx } = ctxFor(mockNas(), null);
  assert.equal((await steerBrowser.handler(ctx, { message: "x" })).isError, true);
  assert.equal((await steerTerminal.handler(ctx, { message: "x" })).isError, true);
});

test("list_browsers and list_terminals show their own kind with owner, purpose and idle time", async () => {
  const nas = mockNas();
  const { ctx } = ctxFor(nas);
  await nas.startTask("browser", { agent_id: "a1", message: "portal" });
  await nas.startTask("terminal", { agent_id: "a2", message: "tests" });
  const task = nas.tasks.get("task/browser/1")!;
  nas.tasks.set(task.task, { ...task, state: "https://portal.example/", last_activity: new Date(Date.now() - 12 * 60_000).toISOString(), status: "idle" });

  const browsers = JSON.parse((await listBrowsers.handler(ctx, {})).content).browsers;
  assert.deepEqual(browsers, [
    { id: "task/browser/1", status: "idle", owner: "a1", purpose: "portal", current: "https://portal.example/", idle_minutes: 12 },
  ]);
  const terminals = JSON.parse((await listTerminals.handler(ctx, {})).content).terminals;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].owner, "a2");
});

test("task addresses parse to a kind and an id, and nothing else does", () => {
  assert.deepEqual(parseTaskAddress("task/browser/3"), { kind: "browser", id: "3" });
  assert.equal(parseTaskAddress("task/other/3"), null);
  assert.equal(parseTaskAddress("browser/3"), null);
});

test("only ingest_memory is defined async, and the flag is a field on a tool's definition", async () => {
  const { toolIsAsync } = await import("../src/runtime/async.js");
  const { allTools, embeddedAgentTools, embeddedFileReadTools, embeddedFileWriteTools, embeddedHelperTools, embeddedSchedulingTools } =
    await import("../src/tools/registry.js");
  assert.equal(toolIsAsync("ingest_memory"), true);
  const everyDefinition = [
    ...allTools(),
    ...embeddedAgentTools(),
    ...embeddedFileReadTools(),
    ...embeddedFileWriteTools(),
    ...embeddedHelperTools(),
    ...embeddedSchedulingTools(),
  ];
  assert.deepEqual(
    everyDefinition.filter((tool) => toolIsAsync(tool.name)).map((tool) => tool.name),
    [],
    "no definition is flagged yet",
  );
  assert.equal(toolIsAsync("recall_memory"), false);
  assert.equal(toolIsAsync("steer_browser"), false);
});

test("a result over the receipt threshold is saved whole to its file, and a short one or a read_file result is not", async () => {
  const { executeTool } = await import("../src/runtime/tools.js");
  const { ToolDebounce } = await import("../src/runtime/tool-debounce.js");
  const nas = mockNas({});
  const page = "p".repeat(3_000);
  const dwar = {
    webFetch: async () => ({
      pages: [{ url: "https://a.example/", final_url: "https://a.example/", status: 200, title: "A", text: page, error: null, answer: null }],
    }),
  };
  const ctx = {
    db: {},
    callerId: "a1",
    callerKind: "agent",
    lane: "work",
    nas,
    dwar,
    files: { nas, dir: "/files" },
    toolDebounce: new ToolDebounce({ base_ms: 1, max_ms: 1 }),
  } as unknown as ToolContext;

  const fetched = await executeTool(ctx, { type: "tool_use", id: "toolu_9", name: "web_fetch", input: { urls: ["https://a.example/"] } });
  assert.equal(fetched.isError, false, fetched.content);
  assert.match(fetched.content, /saved at \/files\/results\/toolu_9\.txt/);
  assert.match(nas.files.get("/files/results/toolu_9.txt")?.toString() ?? "", new RegExp(`=== 1\. https://a\.example/ — A\n${page}`));

  nas.files.set("/h/big.txt", Buffer.from("x".repeat(5_000)));
  await executeTool(ctx, { type: "tool_use", id: "toolu_10", name: "read_file", input: { path: "/h/big.txt" } });
  assert.equal(nas.files.has("/files/results/toolu_10.txt"), false, "a read is cheap to run again");
});
