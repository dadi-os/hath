import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { LIST_AGENTS, SEND_MESSAGE } from "../src/types/domain.js";
import { assembleContext } from "../src/runtime/context.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { migrate } from "../src/db/migrate.js";
import { allTools, findTool } from "../src/tools/registry.js";
import { syncTools } from "../src/tools/sync.js";
import { HathError } from "../src/errors.js";
import {
  insertAgent,
  insertManager,
  insertWorker,
  mockDwar,
  mockGhar,
  mockChaavi,
  mockNas,
  mockYaad,
  openTestDb,
  resetRuntime,
  silentLog,
  testConfig,
} from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
  await resetRuntime(handle.sql, handle.db, config);
});

after(async () => {
  await handle.close();
});

const NAS_TOOLS = [
  "terminal_spawn",
  "terminal_list",
  "terminal_close",
  "terminal_execute_shell",
  "terminal_read",
  "terminal_send_keys",
  "terminal_read_file",
  "terminal_write_file",
  "terminal_edit_file",
  "terminal_glob",
  "terminal_grep",
  "nas_get_update_status",
] as const;

const NAS_DESTRUCTIVE = [
  "nas_restart_module",
  "nas_stack_up",
  "nas_stack_down",
  "nas_provision",
  "nas_pull_updates",
] as const;

test("Nas terminal tools and destructive ops are registered", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  for (const name of [...NAS_TOOLS, ...NAS_DESTRUCTIVE]) {
    assert.equal(findTool(name)?.name, name);
  }
  assert.equal(allTools().length, 52);
  await assert.doesNotReject(() => syncTools(handle.db));
});

test("terminal_spawn forwards terminal_id and leaves a fresh spawn empty", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["terminal_spawn"],
  });
  const nas = mockNas({});
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas,
    config,
    log: silentLog,
  });
  const fresh = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "ts1",
    name: "terminal_spawn",
    input: {},
  });
  assert.equal(fresh.isError, false, fresh.content);
  const named = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "ts2",
    name: "terminal_spawn",
    input: { terminal_id: "t4", cwd: "/var/lib/dadi" },
  });
  assert.equal(named.isError, false, named.content);
  assert.deepEqual(nas.createTerminalCalls, [{}, { id: "t4", cwd: "/var/lib/dadi" }]);
});

test("execute_shell passes through exit code, output, and timed_out", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["terminal_execute_shell"],
  });
  const nas = mockNas({
    exec: () => ({
      exit_code: 7,
      output: "boom\n",
      truncated: false,
      timed_out: true,
    }),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "ex1",
    name: "terminal_execute_shell",
    input: { terminal_id: "t1", command: "sleep 5", timeout_seconds: 1 },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(nas.execCalls, [
    { id: "t1", body: { command: "sleep 5", timeout_seconds: 1 } },
  ]);
  const body = JSON.parse(result.content);
  assert.equal(body.exit_code, 7);
  assert.equal(body.output, "boom\n");
  assert.equal(body.timed_out, true);
  assert.equal(result.audit.terminal_id, "t1");
});

test("Nas 404 becomes not_found tool error without killing the lane", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["terminal_execute_shell"],
  });
  const nas = mockNas({
    exec: () => {
      throw new HathError(404, "not_found", "not_found");
    },
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "ex2",
    name: "terminal_execute_shell",
    input: { terminal_id: "t99", command: "echo hi" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /^not_found:/);
  assert.equal(result.audit.terminal_id, "t99");
});

test("Nas 409 on execute_shell becomes busy tool error", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["terminal_execute_shell"],
  });
  const nas = mockNas({
    exec: () => {
      throw new HathError(409, "busy", "terminal is busy");
    },
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "ex3",
    name: "terminal_execute_shell",
    input: { terminal_id: "t1", command: "echo hi" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /^busy:/);
});

test("edit_file 409 surfaces the match count", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["terminal_edit_file"],
  });
  const nas = mockNas({
    editFile: () => {
      throw new HathError(409, "conflict", "matches: 3");
    },
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "ed1",
    name: "terminal_edit_file",
    input: {
      path: "/var/lib/dadi/a.txt",
      old_string: "foo",
      new_string: "bar",
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /matches: 3/);
  assert.equal(result.audit.path, "/var/lib/dadi/a.txt");
});

test("worker granted execute_shell and read_file sees those plus send_message and yield", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertManager(handle.db);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const childId = await insertAgent(handle.db, {
    name: "coder",
    systemPrompt: "use terminal t1",
    parentAgentId: managerId,
  });
  const granted = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "g-terminal",
    name: "grant_tool",
    input: {
      agent_id: childId,
      tools: [
        { tool_name: "terminal_execute_shell", usage: "use terminal_execute_shell" },
        { tool_name: "terminal_read_file", usage: "use terminal_read_file" },
      ],
    },
  });
  assert.equal(granted.isError, false, granted.content);
  const ctx = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: childId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
    transcriptWindowStep: 20,
  });
  assert.deepEqual(
    ctx.tools.map((tool) => tool.name).sort(),
    [
      "terminal_execute_shell",
      "terminal_read_file",
      SEND_MESSAGE,
      LIST_AGENTS,
      "wait",
      "recall_memory",
      "ingest_memory",
      "manage_agent",
      "modify_agent_prompt",
      "get_agent",
      "grant_tool",
      "revoke_tool",
      "list_tools",
      "get_logs",
      "schedule_message",
      "list_schedules",
      "cancel_schedule",
      "yield",
    ].sort(),
  );
});
