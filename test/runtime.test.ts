import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, asc, eq } from "drizzle-orm";
import {
  DISPATCH_MESSAGE,
  GET_AGENT,
  LIST_AGENTS,
  MANAGE_AGENT,
  MODIFY_AGENT_PROMPT,
  SEND_MESSAGE,
} from "../src/types/domain.js";
import { currentRequester, insertMessage, NO_ATTACHMENTS } from "../src/db/messages.js";
import { assembleContext } from "../src/runtime/context.js";
import { deliverUserMessage, RUNTIME_REPORT } from "../src/runtime/deliver.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { agentLogs, agents, agentTools, messages, scheduledMessages, tools } from "../src/db/schema.js";
import { writeAgentLog } from "../src/db/logs.js";
import { toolId } from "../src/tools/sync.js";
import { allTools, findTool } from "../src/tools/registry.js";
import {
  endTurn,
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
  toolUse,
  yieldTurn,
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

test("two concurrent messages to one agent serialize on its conversation lock", async (t) => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: [],
  });
  let active = 0;
  let overlap = false;
  const dwar = mockDwar({
    converse: async () => {
      active += 1;
      if (active > 1) {
        overlap = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return yieldTurn();
    },
  });
  const runtime = createRuntime({ db: handle.db, dwar, ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(), yaad: mockYaad(), config, log: silentLog });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    runtime,
  });
  t.after(() => app.close());
  const body = {
    to_agent_id: workerId,
    content: "hello",
  };
  const [a, b] = await Promise.all([
    app.inject({ method: "POST", url: "/messages", payload: { ...body, content: "message-one" } }),
    app.inject({ method: "POST", url: "/messages", payload: { ...body, content: "message-two" } }),
  ]);
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  await runtime.waitUntilIdle();
  assert.equal(overlap, false);
  assert.ok(dwar.conversationCalls.length >= 1 && dwar.conversationCalls.length <= 2);
  const lastSeen = JSON.stringify(dwar.conversationCalls.at(-1)?.messages);
  assert.ok(lastSeen.includes("message-one") && lastSeen.includes("message-two"));
});

test("manage_agent on a non-child is rejected", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "parent",
    systemPrompt: "parent prompt",
    tools: [],
  });
  const strangerId = await insertAgent(handle.db, {
    name: "stranger",
    systemPrompt: "stranger prompt",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "m1",
    name: MANAGE_AGENT,
    input: { agent_id: strangerId, retired: true },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /direct children/);
});

test("modify_agent_prompt on a direct child is allowed", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "boss",
    systemPrompt: "boss prompt",
    tools: [],
  });
  const childId = await insertAgent(handle.db, {
    name: "worker",
    systemPrompt: "old prompt",
    parentAgentId: parentId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "m2",
    name: MODIFY_AGENT_PROMPT,
    input: { agent_id: childId, edits: [{ old_string: "old", new_string: "new" }] },
  });
  assert.equal(result.isError, false);
  assert.equal(result.audit.new_system_prompt, "new prompt");
  assert.equal(JSON.parse(result.content).new_system_prompt, undefined);
  assert.equal(JSON.parse(result.content).old_system_prompt, undefined);
  assert.equal(result.audit.old_system_prompt, "old prompt");
});

test("a parent can retire a child and reactivate it; nothing else can change a retired agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, { id: "rehire-parent", systemPrompt: "parent" });
  const childId = await insertAgent(handle.db, {
    id: "rehire-child",
    systemPrompt: "child",
    parentAgentId: parentId,
  });
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
  const call = (name: string, input: Record<string, unknown>, id: string) =>
    executeTool(runtime.toolContext(parentId, "reasoning"), { type: "tool_use", id, name, input });

  const retire = await call(MANAGE_AGENT, { agent_id: childId, retired: true }, "rh1");
  assert.equal(retire.isError, false, retire.content);
  assert.equal(JSON.parse(retire.content).retired, true);

  const promptOnly = await call(
    MODIFY_AGENT_PROMPT,
    { agent_id: childId, edits: [{ old_string: "child", new_string: "still retired?" }] },
    "rh2",
  );
  assert.equal(promptOnly.isError, true);
  assert.match(promptOnly.content, /^retired: agent rehire-child is retired; only its parent can reactivate it/);

  const blocked = await executeTool(runtime.toolContext(parentId, "conversation"), {
    type: "tool_use",
    id: "rh3",
    name: "dispatch_message",
    input: { to_agent_id: childId, content: "are you there?" },
  });
  assert.equal(blocked.isError, true);

  const reactivate = await call(MANAGE_AGENT, { agent_id: childId, retired: false }, "rh4");
  assert.equal(reactivate.isError, false, reactivate.content);
  assert.equal(JSON.parse(reactivate.content).retired, false);
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, childId));
  assert.equal(row?.active, true);
  assert.equal(row?.systemPrompt, "child");

  const delivered = await executeTool(runtime.toolContext(parentId, "conversation"), {
    type: "tool_use",
    id: "rh5",
    name: "dispatch_message",
    input: { to_agent_id: childId, content: "welcome back" },
  });
  assert.equal(delivered.isError, false, delivered.content);
  await runtime.waitUntilIdle();
});

test("modify_agent_prompt edits the prompt of self and a direct child", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "boss",
    systemPrompt: "boss prompt",
    tools: [],
  });
  const childId = await insertAgent(handle.db, {
    name: "worker",
    systemPrompt: "child prompt",
    parentAgentId: parentId,
  });
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

  const self = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "rn-self",
    name: MODIFY_AGENT_PROMPT,
    input: { agent_id: parentId, edits: [{ old_string: "prompt", new_string: "prompt v2" }] },
  });
  assert.equal(self.isError, false);
  const selfBody = JSON.parse(self.content);
  assert.deepEqual(selfBody, { agent_id: parentId, edits_applied: 1 });
  assert.equal(self.audit.old_system_prompt, "boss prompt");
  assert.equal(self.audit.new_system_prompt, "boss prompt v2");
  const [parent] = await handle.db.select().from(agents).where(eq(agents.id, parentId));
  assert.equal(parent?.systemPrompt, "boss prompt v2");
  assert.equal(parent?.id, "boss");

  const child = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "rn-child",
    name: MODIFY_AGENT_PROMPT,
    input: { agent_id: childId, edits: [{ old_string: "prompt", new_string: "prompt v2" }] },
  });
  assert.equal(child.isError, false);
  assert.equal(child.audit.new_system_prompt, "child prompt v2");
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, childId));
  assert.equal(row?.systemPrompt, "child prompt v2");
  assert.equal(row?.id, "worker");
});

test("modify_agent_prompt of a stranger is rejected", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "parent",
    systemPrompt: "parent",
    tools: [],
  });
  const strangerId = await insertAgent(handle.db, {
    name: "stranger",
    systemPrompt: "stranger",
  });
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
  const result = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "rn-stranger",
    name: MODIFY_AGENT_PROMPT,
    input: { agent_id: strangerId, edits: [{ old_string: "stranger", new_string: "hijacked" }] },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /direct children/);
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, strangerId));
  assert.equal(row?.systemPrompt, "stranger");
});

test("modify_agent_prompt saves nothing unless every edit matches exactly once", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const selfId = await insertWorker(handle.db, {
    name: "alpha",
    systemPrompt: "alpha beta alpha",
    tools: [],
  });
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
  const edit = (edits: unknown, id: string) =>
    executeTool(runtime.toolContext(selfId, "reasoning"), {
      type: "tool_use",
      id,
      name: MODIFY_AGENT_PROMPT,
      input: { agent_id: selfId, edits },
    });

  const missing = await edit([{ old_string: "gamma", new_string: "x" }], "rn-missing");
  assert.equal(missing.isError, true);
  assert.match(missing.content, /edit 1: expected exactly 1 match of old_string, got 0/);

  const ambiguous = await edit([{ old_string: "alpha", new_string: "x" }], "rn-ambiguous");
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content, /got 2/);

  const partial = await edit(
    [
      { old_string: "beta", new_string: "B" },
      { old_string: "beta", new_string: "C" },
    ],
    "rn-partial",
  );
  assert.equal(partial.isError, true);
  assert.match(partial.content, /edit 2: .*got 0/);

  const none = await edit([], "rn-none");
  assert.equal(none.isError, true);

  const [row] = await handle.db.select().from(agents).where(eq(agents.id, selfId));
  assert.equal(row?.systemPrompt, "alpha beta alpha");

  const dollar = await edit([{ old_string: "beta", new_string: "$& costs $1" }], "rn-dollar");
  assert.equal(dollar.isError, false, dollar.content);
  const [after] = await handle.db.select().from(agents).where(eq(agents.id, selfId));
  assert.equal(after?.systemPrompt, "alpha $& costs $1 alpha");
});

test("manage_agent retires without touching the prompt", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const selfId = await insertWorker(handle.db, {
    name: "solo",
    systemPrompt: "keep me",
    tools: [],
  });
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
  const result = await executeTool(runtime.toolContext(selfId, "reasoning"), {
    type: "tool_use",
    id: "rn-only",
    name: MANAGE_AGENT,
    input: { agent_id: selfId, retired: true },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content), { agent_id: selfId, retired: true });
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, selfId));
  assert.equal(row?.active, false);
  assert.equal(row?.systemPrompt, "keep me");

  const missingFlag = await executeTool(runtime.toolContext(selfId, "reasoning"), {
    type: "tool_use",
    id: "rn-no-flag",
    name: MANAGE_AGENT,
    input: { agent_id: selfId },
  });
  assert.equal(missingFlag.isError, true);

  const again = await executeTool(runtime.toolContext(selfId, "reasoning"), {
    type: "tool_use",
    id: "rn-after",
    name: MODIFY_AGENT_PROMPT,
    input: { agent_id: selfId, edits: [{ old_string: "keep me", new_string: "back again" }] },
  });
  assert.equal(again.isError, true);
  assert.equal(
    again.content,
    `retired: agent ${selfId} is retired; only its parent can reactivate it, with manage_agent retired false`,
  );
});

test("reasoning context has send_message, list_agents, and no dispatch_message", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: [],
  });
  const ctx = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: workerId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
    transcriptWindowStep: 20,
  });
  const names = ctx.tools.map((tool) => tool.name);
  assert.ok(names.includes(SEND_MESSAGE));
  assert.ok(names.includes(LIST_AGENTS));
  assert.ok(names.includes("yield"));
  assert.equal(names.includes(DISPATCH_MESSAGE), false);
});

test("reasoning cannot write another agent's mailbox", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const callerId = await insertAgent(handle.db, {
    name: "caller",
    systemPrompt: "empty grants",
  });
  const targetId = await insertAgent(handle.db, {
    name: "mailbox",
    systemPrompt: "mailbox",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const before = runtime.transcript.transcriptFor(targetId).length;
  const result = await executeTool(runtime.toolContext(callerId, "reasoning"), {
    type: "tool_use",
    id: "d1",
    name: DISPATCH_MESSAGE,
    input: { to_agent_id: targetId, content: "sneak" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /unknown reasoning tool/);
  const after = runtime.transcript.transcriptFor(targetId).length;
  assert.equal(before, after);
});

test("a steer with reasoning idle starts a Dwar reasoning call", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const callerId = await insertAgent(handle.db, {
    name: "steer-caller",
    systemPrompt: "steer",
  });
  const dwar = mockDwar({
    reason: async () => yieldTurn("steered"),
    converse: async () => yieldTurn(),
  });
  const runtime = createRuntime({ db: handle.db, dwar, ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(), yaad: mockYaad(), config, log: silentLog });
  await executeTool(runtime.toolContext(callerId, "conversation"), {
    type: "tool_use",
    id: "s1",
    name: "steer_reasoning",
    input: { instruction: "wake up" },
  });
  await runtime.waitUntilIdle();
  assert.ok(dwar.reasoningCalls.length >= 1);
  const first = dwar.reasoningCalls[0];
  assert.ok(first);
  const blob = JSON.stringify(first.messages);
  assert.match(blob, /wake up/);
});

test("reasoning exit without send_message does not wake conversation", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const callerId = await insertAgent(handle.db, {
    name: "quiet-reasoner",
    systemPrompt: "think quietly",
  });
  const dwar = mockDwar({
    reason: async () => yieldTurn("r-yield"),
    converse: async () => yieldTurn(),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  runtime.transcript.append({
    fromAgentId: null,
    toAgentId: callerId,
    content: "earlier user note",
  });
  runtime.transcript.append({
    fromAgentId: callerId,
    toAgentId: null,
    content: "already replied",
  });
  await executeTool(runtime.toolContext(callerId, "conversation"), {
    type: "tool_use",
    id: "s-quiet",
    name: "steer_reasoning",
    input: { instruction: "think then stop" },
  });
  await runtime.waitUntilIdle();
  assert.ok(dwar.reasoningCalls.length >= 1);
  assert.equal(dwar.conversationCalls.length, 0);
});

test("send_message wakes conversation once; reasoning exit does not double-wake", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const callerId = await insertAgent(handle.db, {
    name: "handoff-reasoner",
    systemPrompt: "hand off",
  });
  let reasonTurn = 0;
  const dwar = mockDwar({
    reason: async () => {
      reasonTurn += 1;
      if (reasonTurn === 1) {
        return toolUse(
          SEND_MESSAGE,
          { to_agent_id: null, intent: "say hi" },
          "sm-1",
        );
      }
      return yieldTurn("r-yield");
    },
    converse: async () => yieldTurn("c-yield"),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar,
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    yaad: mockYaad(),
    config,
    log: silentLog,
  });
  await executeTool(runtime.toolContext(callerId, "conversation"), {
    type: "tool_use",
    id: "s-handoff",
    name: "steer_reasoning",
    input: { instruction: "compose a hello" },
  });
  await runtime.waitUntilIdle();
  assert.ok(dwar.reasoningCalls.length >= 1);
  assert.equal(dwar.conversationCalls.length, 1);
  const converse = dwar.conversationCalls[0];
  assert.ok(converse);
  const blob = JSON.stringify(converse.messages);
  assert.match(blob, /say hi/);
  const last = converse.messages[converse.messages.length - 1];
  assert.ok(last);
  assert.equal(last.role, "user");
});

test("conversation tools are dispatch_message, steer_reasoning, list_agents, yield — never route_message", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: [],
  });
  const ctx = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: workerId,
    lane: "conversation",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
    transcriptWindowStep: 20,
  });
  const names = ctx.tools.map((tool) => tool.name);
  assert.ok(names.includes(DISPATCH_MESSAGE));
  assert.ok(names.includes("steer_reasoning"));
  assert.ok(names.includes(LIST_AGENTS));
  assert.ok(names.includes("yield"));
  assert.equal(names.includes(SEND_MESSAGE), false);
  assert.equal(names.includes("route_message"), false);
});

test("spawn_agent requires system_prompt and grants nothing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertManager(handle.db);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const missing = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "sp0",
    name: "hath_spawn_agent",
    input: { id: "no-prompt-child" },
  });
  assert.equal(missing.isError, true);

  const spawned = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "sp1",
    name: "hath_spawn_agent",
    input: { id: "fresh-child", system_prompt: "do one job" },
  });
  assert.equal(spawned.isError, false);
  const childId = JSON.parse(spawned.content).agent_id as string;
  const childCtx = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: childId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
    transcriptWindowStep: 20,
  });
  assert.deepEqual(
    childCtx.tools.map((tool) => tool.name),
    [
      SEND_MESSAGE,
      "read_attachment",
      "create_attachment",
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
    ],
  );
});

test("grant_tool on a direct child succeeds and appears in assembleContext", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertManager(handle.db);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const childId = await insertAgent(handle.db, {
    name: "grantee",
    systemPrompt: "child",
    parentAgentId: managerId,
  });
  const granted = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "g1",
    name: "grant_tool",
    input: {
      agent_id: childId,
      tools: [{ tool_name: "hath_spawn_agent", usage: "tune your own prompt" }],
    },
  });
  assert.equal(granted.isError, false);
  const ctx = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: childId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
    transcriptWindowStep: 20,
  });
  const names = ctx.tools.map((tool) => tool.name);
  assert.ok(names.includes("hath_spawn_agent"));
  assert.ok(names.includes(SEND_MESSAGE));
});

test("grant_tool on a non-child fails", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertManager(handle.db);
  const strangerId = await insertAgent(handle.db, {
    name: "stranger-grant",
    systemPrompt: "stranger",
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "g2",
    name: "grant_tool",
    input: {
      agent_id: strangerId,
      tools: [{ tool_name: "hath_spawn_agent", usage: "nope" }],
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /direct children/);
});

test("grant_tool and manage_agent reject a grandchild for a normal agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertManager(handle.db, {
    name: "grandparent",
    systemPrompt: "top",
  });
  const childId = await insertAgent(handle.db, {
    name: "child",
    systemPrompt: "mid",
    parentAgentId: parentId,
  });
  const grandchildId = await insertAgent(handle.db, {
    name: "grandchild",
    systemPrompt: "leaf",
    parentAgentId: childId,
  });
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
  const grant = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "g-gc",
    name: "grant_tool",
    input: {
      agent_id: grandchildId,
      tools: [{ tool_name: "yaad_search_history", usage: "nope" }],
    },
  });
  assert.equal(grant.isError, true);
  assert.match(grant.content, /direct children/);

  const modify = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "m-gc",
    name: MANAGE_AGENT,
    input: { agent_id: grandchildId, retired: true },
  });
  assert.equal(modify.isError, true);
  assert.match(modify.content, /direct children/);
});

test("as the router, grant_tool reaches a root but not a nested agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const rootId = await insertAgent(handle.db, {
    name: "root-for-dadi",
    systemPrompt: "root",
  });
  const parentId = await insertAgent(handle.db, {
    name: "other-parent",
    systemPrompt: "parent",
  });
  const nestedId = await insertAgent(handle.db, {
    name: "nested-under-other",
    systemPrompt: "nested",
    parentAgentId: parentId,
  });
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
  const dadi = runtime.toolContext(null, "reasoning");

  const rootGrant = await executeTool(dadi, {
    type: "tool_use",
    id: "dadi-root",
    name: "grant_tool",
    input: {
      agent_id: rootId,
      tools: [{ tool_name: "yaad_search_history", usage: "remember for the root" }],
    },
  });
  assert.equal(rootGrant.isError, false, rootGrant.content);

  const nestedGrant = await executeTool(dadi, {
    type: "tool_use",
    id: "dadi-nested",
    name: "grant_tool",
    input: {
      agent_id: nestedId,
      tools: [{ tool_name: "yaad_get_node_history", usage: "query for the nested agent" }],
    },
  });
  assert.equal(nestedGrant.isError, true);
  assert.match(nestedGrant.content, /direct children/);

  const grants = await handle.db.select().from(agentTools);
  const byAgent = new Map(grants.map((row) => [row.agentId, row.toolId]));
  assert.equal(byAgent.get(rootId), toolId("yaad_search_history"));
  assert.equal(byAgent.get(nestedId), undefined);
});

test("as the router, manage_agent and modify_agent_prompt are refused and change nothing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, {
    name: "parent-mod",
    systemPrompt: "parent",
  });
  const nestedId = await insertAgent(handle.db, {
    name: "nested-mod",
    systemPrompt: "old",
    parentAgentId: parentId,
  });
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
  const retire = await executeTool(runtime.toolContext(null, "reasoning"), {
    type: "tool_use",
    id: "dadi-manage",
    name: MANAGE_AGENT,
    input: { agent_id: nestedId, retired: true },
  });
  assert.equal(retire.isError, true);
  assert.match(retire.content, /agent identity/);
  const edit = await executeTool(runtime.toolContext(null, "reasoning"), {
    type: "tool_use",
    id: "dadi-edit",
    name: MODIFY_AGENT_PROMPT,
    input: { agent_id: nestedId, edits: [{ old_string: "old", new_string: "new" }] },
  });
  assert.equal(edit.isError, true);
  assert.match(edit.content, /agent identity/);
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, nestedId));
  assert.equal(row?.systemPrompt, "old");
  assert.equal(row?.active, true);
});

const storedPrompt = "revise me in place\nkeep  the double space\tand \"quotes\" — café";

test("get_agent returns a direct child's stored prompt byte for byte", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "prompt-parent",
    systemPrompt: "parent",
    tools: [],
  });
  const childId = await insertAgent(handle.db, {
    name: "prompt-child",
    systemPrompt: storedPrompt,
    parentAgentId: parentId,
  });
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
  const result = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "get-child",
    name: GET_AGENT,
    input: { agent_id: childId },
  });
  assert.equal(result.isError, false, result.content);
  const body = JSON.parse(result.content) as { system_prompt: string; parent_agent_id: string };
  assert.equal(body.system_prompt, storedPrompt);
  assert.equal(body.parent_agent_id, parentId);
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, childId));
  assert.equal(body.system_prompt, row?.systemPrompt);
});

test("get_agent lets an agent read itself", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const selfId = await insertWorker(handle.db, {
    name: "self-reader",
    systemPrompt: storedPrompt,
    tools: [],
  });
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
  const result = await executeTool(runtime.toolContext(selfId, "reasoning"), {
    type: "tool_use",
    id: "get-self",
    name: GET_AGENT,
    input: { agent_id: selfId },
  });
  assert.equal(result.isError, false, result.content);
  const body = JSON.parse(result.content) as {
    name: string;
    system_prompt: string;
    parent_agent_id: string | null;
    retired: boolean;
  };
  assert.equal(body.name, "self-reader");
  assert.equal(body.system_prompt, storedPrompt);
  assert.equal(body.parent_agent_id, null);
  assert.equal(body.retired, false);
});

test("get_agent refuses a grandchild and a sibling with the self-or-direct-child rule", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const grandparentId = await insertWorker(handle.db, {
    name: "grandparent",
    systemPrompt: "top",
    tools: [],
  });
  const childId = await insertAgent(handle.db, {
    name: "mid",
    systemPrompt: "mid",
    parentAgentId: grandparentId,
  });
  const grandchildId = await insertAgent(handle.db, {
    name: "leaf",
    systemPrompt: "leaf prompt",
    parentAgentId: childId,
  });
  const siblingId = await insertWorker(handle.db, {
    name: "sibling",
    systemPrompt: "sibling",
    parentAgentId: grandparentId,
    tools: [],
  });
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

  const grandchild = await executeTool(runtime.toolContext(grandparentId, "reasoning"), {
    type: "tool_use",
    id: "get-grandchild",
    name: GET_AGENT,
    input: { agent_id: grandchildId },
  });
  assert.equal(grandchild.isError, true);
  assert.match(grandchild.content, /self or direct children/);
  assert.doesNotMatch(grandchild.content, /not found/);

  const sibling = await executeTool(runtime.toolContext(siblingId, "reasoning"), {
    type: "tool_use",
    id: "get-sibling",
    name: GET_AGENT,
    input: { agent_id: childId },
  });
  assert.equal(sibling.isError, true);
  assert.match(sibling.content, /self or direct children/);
  assert.doesNotMatch(sibling.content, /not found/);
});

test("as Dadi, get_agent reads any agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, {
    name: "other-parent",
    systemPrompt: "parent",
  });
  const nestedId = await insertAgent(handle.db, {
    name: "nested-stranger",
    systemPrompt: storedPrompt,
    parentAgentId: parentId,
  });
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
  const result = await executeTool(runtime.toolContext(null, "reasoning", "router"), {
    type: "tool_use",
    id: "dadi-get",
    name: GET_AGENT,
    input: { agent_id: nestedId },
  });
  assert.equal(result.isError, false, result.content);
  assert.equal(JSON.parse(result.content).system_prompt, storedPrompt);
});

test("get_agent tool names match agent_tools for that agent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "tools-parent",
    systemPrompt: "parent",
    tools: [],
  });
  const childId = await insertWorker(handle.db, {
    name: "tools-child",
    systemPrompt: "child",
    parentAgentId: parentId,
    tools: ["yaad_search_history", "hath_spawn_agent"],
  });
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
  const result = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "get-tools",
    name: GET_AGENT,
    input: { agent_id: childId },
  });
  assert.equal(result.isError, false, result.content);
  const held = await handle.db
    .select({ name: tools.name })
    .from(agentTools)
    .innerJoin(tools, eq(agentTools.toolId, tools.id))
    .where(eq(agentTools.agentId, childId))
    .orderBy(asc(tools.name));
  assert.deepEqual(
    (JSON.parse(result.content) as { tools: string[] }).tools,
    held.map((row) => row.name),
  );
  assert.deepEqual((JSON.parse(result.content) as { tools: string[] }).tools, [
    "hath_spawn_agent",
    "yaad_search_history",
  ]);
});

test("an edit built from get_agent's prompt changes only the edited text", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "round-parent",
    systemPrompt: "parent",
    tools: [],
  });
  const childId = await insertAgent(handle.db, {
    name: "round-child",
    systemPrompt: storedPrompt,
    parentAgentId: parentId,
  });
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
  const ctx = runtime.toolContext(parentId, "reasoning");
  const before = await executeTool(ctx, {
    type: "tool_use",
    id: "round-read",
    name: GET_AGENT,
    input: { agent_id: childId },
  });
  assert.equal(before.isError, false, before.content);
  const prompt = (JSON.parse(before.content) as { system_prompt: string }).system_prompt;
  assert.equal(prompt, storedPrompt);

  const modified = await executeTool(ctx, {
    type: "tool_use",
    id: "round-write",
    name: MODIFY_AGENT_PROMPT,
    input: {
      agent_id: childId,
      edits: [{ old_string: prompt.split("\n")[1], new_string: "keep the café line" }],
    },
  });
  assert.equal(modified.isError, false, modified.content);

  const after = await executeTool(ctx, {
    type: "tool_use",
    id: "round-reread",
    name: GET_AGENT,
    input: { agent_id: childId },
  });
  assert.equal(after.isError, false, after.content);
  const edited = "revise me in place\nkeep the café line";
  assert.equal((JSON.parse(after.content) as { system_prompt: string }).system_prompt, edited);
  const [row] = await handle.db.select().from(agents).where(eq(agents.id, childId));
  assert.equal(row?.systemPrompt, edited);
});

test("as Dadi, schedule_message fails without writing a row", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const targetId = await insertAgent(handle.db, {
    name: "sched-target",
    systemPrompt: "target",
  });
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
  const before = await handle.db.select().from(scheduledMessages);
  const result = await executeTool(runtime.toolContext(null, "reasoning"), {
    type: "tool_use",
    id: "dadi-sched",
    name: "schedule_message",
    input: {
      to_agent_id: targetId,
      content: "later",
      run_at: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /agent identity/);
  const after = await handle.db.select().from(scheduledMessages);
  assert.equal(after.length, before.length);
});

test("as Dadi, send_message and dispatch_message fail and deliver nothing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const targetId = await insertAgent(handle.db, {
    name: "msg-target",
    systemPrompt: "target",
  });
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
  const before = runtime.transcript.transcriptFor(targetId).length;

  const send = await executeTool(runtime.toolContext(null, "reasoning"), {
    type: "tool_use",
    id: "dadi-send",
    name: SEND_MESSAGE,
    input: { to_agent_id: targetId, intent: "say hi" },
  });
  assert.equal(send.isError, true);
  assert.match(send.content, /agent identity/);

  const dispatch = await executeTool(runtime.toolContext(null, "conversation"), {
    type: "tool_use",
    id: "dadi-dispatch",
    name: DISPATCH_MESSAGE,
    input: { to_agent_id: targetId, content: "hi" },
  });
  assert.equal(dispatch.isError, true);
  assert.match(dispatch.content, /agent identity/);

  assert.equal(runtime.transcript.transcriptFor(targetId).length, before);
});

test("grant_tool naming an unknown tool fails", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertManager(handle.db);
  const childId = await insertAgent(handle.db, {
    name: "unknown-tool-child",
    systemPrompt: "child",
    parentAgentId: managerId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "g3",
    name: "grant_tool",
    input: {
      agent_id: childId,
      tools: [
        { tool_name: "hath_spawn_agent", usage: "would be fine alone" },
        { tool_name: "not_a_real_tool", usage: "nope" },
      ],
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /no tool named not_a_real_tool; nothing was granted/);
  const grants = await handle.db.select().from(agentTools).where(eq(agentTools.agentId, childId));
  assert.equal(grants.length, 0);
});

test("grant_tool grants a list in one call, updates usage, and rejects a repeated name", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertManager(handle.db);
  const childId = await insertAgent(handle.db, {
    name: "list-grant-child",
    systemPrompt: "child",
    parentAgentId: managerId,
  });
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
  const grant = (tools: unknown, id: string) =>
    executeTool(runtime.toolContext(managerId, "reasoning"), {
      type: "tool_use",
      id,
      name: "grant_tool",
      input: { agent_id: childId, tools },
    });

  const both = await grant(
    [
      { tool_name: "yaad_search_history", usage: "find past plans" },
      { tool_name: "yaad_get_node_history", usage: "check corrections" },
    ],
    "gl1",
  );
  assert.equal(both.isError, false, both.content);
  assert.deepEqual(JSON.parse(both.content).tool_names, [
    "yaad_search_history",
    "yaad_get_node_history",
  ]);

  const again = await grant([{ tool_name: "yaad_search_history", usage: "newer reason" }], "gl2");
  assert.equal(again.isError, false, again.content);
  const rows = await handle.db.select().from(agentTools).where(eq(agentTools.agentId, childId));
  assert.equal(rows.length, 2);
  assert.equal(
    rows.find((row) => row.toolId === toolId("yaad_search_history"))?.usage,
    "newer reason",
  );

  const repeated = await grant(
    [
      { tool_name: "hath_spawn_agent", usage: "one" },
      { tool_name: "hath_spawn_agent", usage: "two" },
    ],
    "gl3",
  );
  assert.equal(repeated.isError, true);
  assert.match(repeated.content, /hath_spawn_agent listed more than once; nothing was granted/);

  const empty = await grant([], "gl4");
  assert.equal(empty.isError, true);
});

test("revoke_tool removes a grant and fails when the child does not hold it", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertManager(handle.db);
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const childId = await insertAgent(handle.db, {
    name: "revoke-child",
    systemPrompt: "child",
    parentAgentId: managerId,
  });
  await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "r0",
    name: "grant_tool",
    input: {
      agent_id: childId,
      tools: [{ tool_name: "hath_spawn_agent", usage: "temporary" }],
    },
  });
  const revoked = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "r1",
    name: "revoke_tool",
    input: { agent_id: childId, tool_name: "hath_spawn_agent" },
  });
  assert.equal(revoked.isError, false);
  const ctx = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: childId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
    transcriptWindowStep: 20,
  });
  assert.equal(
    ctx.tools.map((tool) => tool.name).includes("hath_spawn_agent"),
    false,
  );
  const again = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "r2",
    name: "revoke_tool",
    input: { agent_id: childId, tool_name: "hath_spawn_agent" },
  });
  assert.equal(again.isError, true);
  assert.match(again.content, /does not hold/);
});

test("an agent can grant a tool it does not itself hold", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, {
    name: "router",
    systemPrompt: "router",
  });
  const childId = await insertAgent(handle.db, {
    name: "worker",
    systemPrompt: "worker",
    parentAgentId: parentId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(),
    config,
    log: silentLog,
  });
  const parentCtx = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: parentId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
    transcriptWindowStep: 20,
  });
  assert.equal(
    parentCtx.tools.map((tool) => tool.name).includes("hath_spawn_agent"),
    false,
  );
  const granted = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "g4",
    name: "grant_tool",
    input: {
      agent_id: childId,
      tools: [{ tool_name: "hath_spawn_agent", usage: "you may modify yourself" }],
    },
  });
  assert.equal(granted.isError, false);
  const childCtx = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId: childId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
    transcriptWindowStep: 20,
  });
  assert.ok(childCtx.tools.map((tool) => tool.name).includes("hath_spawn_agent"));
});

test("list_agents is in both lanes for an agent with no grants", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, {
    name: "no-grants",
    systemPrompt: "empty",
  });
  const reasoning = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId,
    lane: "reasoning",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
    transcriptWindowStep: 20,
  });
  const conversation = await assembleContext({
    db: handle.db,
    serviceRoot: config.serviceRoot,
    agentId,
    lane: "conversation",
    transcript: new TranscriptStore(),
    transcriptWindowMessages: 40,
    transcriptWindowStep: 20,
  });
  assert.deepEqual(reasoning.tools.map((tool) => tool.name), [
    SEND_MESSAGE,
    "read_attachment",
    "create_attachment",
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
  ]);
  assert.ok(conversation.tools.map((tool) => tool.name).includes(LIST_AGENTS));
});

test("list_agents is absent from GET /tools, the tools table, and grant_tool", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  assert.equal(findTool(LIST_AGENTS), undefined);
  assert.equal(
    allTools().some((tool) => tool.name === LIST_AGENTS),
    false,
  );
  const rows = await handle.db.select().from(tools).where(eq(tools.name, LIST_AGENTS));
  assert.equal(rows.length, 0);

  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
  });
  const res = await app.inject({ method: "GET", url: "/tools" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { tools: { name: string }[] };
  assert.equal(
    body.tools.some((tool) => tool.name === LIST_AGENTS),
    false,
  );
  await app.close();

  const managerId = await insertManager(handle.db);
  const childId = await insertAgent(handle.db, {
    name: "grant-list-child",
    systemPrompt: "child",
    parentAgentId: managerId,
  });
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
  const granted = await executeTool(runtime.toolContext(managerId, "reasoning"), {
    type: "tool_use",
    id: "g-list",
    name: "grant_tool",
    input: {
      agent_id: childId,
      tools: [{ tool_name: LIST_AGENTS, usage: "should fail" }],
    },
  });
  assert.equal(granted.isError, true);
  assert.match(granted.content, /no tool named list_agents/);
});

test("list_agents exact id is case-sensitive and empty on miss", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const codingId = await insertAgent(handle.db, {
    name: "coding-manager",
    systemPrompt: "terminals",
  });
  const callerId = await insertAgent(handle.db, {
    name: "caller",
    systemPrompt: "look up",
  });
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
  const hit = await executeTool(runtime.toolContext(callerId, "reasoning"), {
    type: "tool_use",
    id: "la1",
    name: LIST_AGENTS,
    input: { id: "coding-manager" },
  });
  assert.equal(hit.isError, false);
  const hitBody = JSON.parse(hit.content) as {
    agents: { id: string; name: string; parent_agent_id: string | null; parent_name: string | null; retired: boolean }[];
  };
  assert.equal(hitBody.agents.length, 1);
  assert.equal(hitBody.agents[0]?.id, codingId);
  assert.equal(hitBody.agents[0]?.name, "coding-manager");
  assert.equal(hitBody.agents[0]?.parent_agent_id, null);
  assert.equal(hitBody.agents[0]?.parent_name, null);
  assert.equal(hitBody.agents[0]?.retired, false);

  const missCase = await executeTool(runtime.toolContext(callerId, "reasoning"), {
    type: "tool_use",
    id: "la2",
    name: LIST_AGENTS,
    input: { id: "coding-manger" },
  });
  assert.equal(missCase.isError, false);
  assert.deepEqual(JSON.parse(missCase.content).agents, []);

  const missName = await executeTool(runtime.toolContext(callerId, "reasoning"), {
    type: "tool_use",
    id: "la3",
    name: LIST_AGENTS,
    input: { id: "does-not-exist" },
  });
  assert.equal(missName.isError, false);
  assert.deepEqual(JSON.parse(missName.content).agents, []);
});

test("list_agents omits retired agents unless show_retired", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const activeId = await insertAgent(handle.db, {
    name: "active-root",
    systemPrompt: "active",
  });
  const retiredId = await insertAgent(handle.db, {
    name: "retired-root",
    systemPrompt: "retired",
  });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, retiredId));
  const callerId = await insertAgent(handle.db, {
    name: "lister",
    systemPrompt: "list",
  });
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

  const activeOnly = await executeTool(runtime.toolContext(callerId, "reasoning"), {
    type: "tool_use",
    id: "la4",
    name: LIST_AGENTS,
    input: {},
  });
  assert.equal(activeOnly.isError, false);
  const activeBody = JSON.parse(activeOnly.content) as {
    agents: { id: string; name: string; retired: boolean }[];
  };
  const activeIds = new Set(activeBody.agents.map((row) => row.id));
  assert.ok(activeIds.has(activeId));
  assert.ok(activeIds.has(callerId));
  assert.equal(activeIds.has(retiredId), false);

  const withRetired = await executeTool(runtime.toolContext(callerId, "reasoning"), {
    type: "tool_use",
    id: "la5",
    name: LIST_AGENTS,
    input: { show_retired: true },
  });
  assert.equal(withRetired.isError, false);
  const retiredBody = JSON.parse(withRetired.content) as {
    agents: { id: string; name: string; retired: boolean }[];
  };
  const retired = retiredBody.agents.find((row) => row.id === retiredId);
  assert.ok(retired);
  assert.equal(retired.retired, true);
  assert.equal(retired.name, "retired-root");
});

test("list_agents resolves parent_name when the parent is retired", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, {
    name: "retired-parent",
    systemPrompt: "retired",
  });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, parentId));
  const childId = await insertAgent(handle.db, {
    name: "awake-child",
    systemPrompt: "nested",
    parentAgentId: parentId,
  });
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
  const listed = await executeTool(runtime.toolContext(childId, "reasoning"), {
    type: "tool_use",
    id: "la7",
    name: LIST_AGENTS,
    input: { id: "awake-child" },
  });
  assert.equal(listed.isError, false);
  const body = JSON.parse(listed.content) as {
    agents: { id: string; parent_agent_id: string | null; parent_name: string | null }[];
  };
  assert.equal(body.agents.length, 1);
  assert.equal(body.agents[0]?.parent_agent_id, parentId);
  assert.equal(body.agents[0]?.parent_name, "retired-parent");
});

test("list_agents visibility is global across parents", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const rootA = await insertAgent(handle.db, {
    name: "root-a",
    systemPrompt: "a",
  });
  const rootB = await insertAgent(handle.db, {
    name: "root-b",
    systemPrompt: "b",
  });
  const childOfB = await insertAgent(handle.db, {
    name: "child-of-b",
    systemPrompt: "nested",
    parentAgentId: rootB,
  });
  const nestedCaller = await insertAgent(handle.db, {
    name: "nested-caller",
    systemPrompt: "under a",
    parentAgentId: rootA,
  });
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

  const listed = await executeTool(runtime.toolContext(nestedCaller, "conversation"), {
    type: "tool_use",
    id: "la6",
    name: LIST_AGENTS,
    input: {},
  });
  assert.equal(listed.isError, false);
  const body = JSON.parse(listed.content) as {
    agents: {
      id: string;
      name: string;
      parent_agent_id: string | null;
      parent_name: string | null;
    }[];
  };
  const byId = new Map(body.agents.map((row) => [row.id, row]));
  assert.ok(byId.has(rootA));
  assert.ok(byId.has(rootB));
  assert.ok(byId.has(childOfB));
  assert.ok(byId.has(nestedCaller));
  assert.equal(byId.get(childOfB)?.parent_agent_id, rootB);
  assert.equal(byId.get(childOfB)?.parent_name, "root-b");
  assert.equal(byId.get(nestedCaller)?.parent_name, "root-a");
});

test("get_logs searches, clips long strings, and pages back with next_before", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertWorker(handle.db, { name: "log-search", systemPrompt: "searcher", tools: [] });
  await writeAgentLog(handle.db, {
    agentId,
    lane: "conversation",
    event: "message",
    payload: { content: "Here is the revised Batch 2 (Thursday, Oct 8): Zehua Li, Sandra Kue" },
  });
  for (let i = 0; i < 30; i += 1) {
    await writeAgentLog(handle.db, {
      agentId,
      lane: "reasoning",
      event: "tool_result",
      payload: { name: "browser_accessibility_tree", content: "x".repeat(10_000) },
    });
  }
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
  const read = async (input: Record<string, unknown>) => {
    const result = await executeTool(runtime.toolContext(agentId, "reasoning"), {
      type: "tool_use",
      id: "gls",
      name: "get_logs",
      input,
    });
    assert.equal(result.isError, false, result.content);
    return JSON.parse(result.content) as {
      logs: Array<{ event: string; payload: { content: string } }>;
      next_before: string | null;
    };
  };

  const found = await read({ search: "batch 2" });
  assert.equal(found.logs.length, 1);
  assert.match(found.logs[0]?.payload.content ?? "", /Zehua Li/);
  assert.equal(found.next_before, null);

  const page = await read({ event: "tool_result" });
  assert.ok(page.logs.length > 0 && page.logs.length < 30);
  assert.match(page.logs[0]?.payload.content ?? "", /\[8000 more chars\]$/);
  assert.ok(JSON.stringify(page.logs).length <= 40_000);
  assert.ok(page.next_before !== null);

  const older = await read({ event: "tool_result", before: page.next_before });
  assert.ok(older.logs.length > 0);
});

test("get_logs defaults to caller and allows direct children only", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertWorker(handle.db, {
    name: "log-parent",
    systemPrompt: "parent",
    tools: [],
  });
  const childId = await insertWorker(handle.db, {
    name: "log-child",
    systemPrompt: "child",
    parentAgentId: parentId,
    tools: [],
  });
  const strangerId = await insertWorker(handle.db, {
    name: "log-stranger",
    systemPrompt: "stranger",
    tools: [],
  });
  await writeAgentLog(handle.db, {
    agentId: parentId,
    lane: "reasoning",
    event: "response",
    payload: { text: "parent thought" },
  });
  await writeAgentLog(handle.db, {
    agentId: childId,
    lane: "reasoning",
    event: "response",
    payload: { text: "child thought" },
  });
  await writeAgentLog(handle.db, {
    agentId: strangerId,
    lane: "reasoning",
    event: "response",
    payload: { text: "stranger thought" },
  });
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

  const self = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "gl1",
    name: "get_logs",
    input: {},
  });
  assert.equal(self.isError, false, self.content);
  const selfBody = JSON.parse(self.content) as {
    logs: Array<{ agent_id: string; payload: { text: string } }>;
  };
  assert.equal(selfBody.logs.length, 1);
  assert.equal(selfBody.logs[0]?.agent_id, parentId);
  assert.equal(selfBody.logs[0]?.payload.text, "parent thought");

  const child = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "gl2",
    name: "get_logs",
    input: { agent_id: childId },
  });
  assert.equal(child.isError, false, child.content);
  const childBody = JSON.parse(child.content) as {
    logs: Array<{ agent_id: string; payload: { text: string } }>;
  };
  assert.equal(childBody.logs.length, 1);
  assert.equal(childBody.logs[0]?.agent_id, childId);

  const denied = await executeTool(runtime.toolContext(parentId, "reasoning"), {
    type: "tool_use",
    id: "gl3",
    name: "get_logs",
    input: { agent_id: strangerId },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content, /direct children/);

  const asRouter = await executeTool(runtime.toolContext(null, "router"), {
    type: "tool_use",
    id: "gl4",
    name: "get_logs",
    input: {},
  });
  assert.equal(asRouter.isError, true);
  assert.match(asRouter.content, /ephemeral/);

  const asUser = await executeTool(runtime.toolContext(null, "router", "user"), {
    type: "tool_use",
    id: "gl5",
    name: "get_logs",
    input: {},
  });
  assert.equal(asUser.isError, false, asUser.content);
  assert.deepEqual(JSON.parse(asUser.content).logs, []);
});

test("executeTool denies registry tools without grant or when retired", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const ungranted = await insertWorker(handle.db, {
    name: "no-grant",
    systemPrompt: "none",
    tools: [],
  });
  const retired = await insertWorker(handle.db, {
    name: "retired-worker",
    systemPrompt: "retired",
    tools: ["yaad_search_history"],
  });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, retired));
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

  const noGrant = await executeTool(runtime.toolContext(ungranted, "reasoning"), {
    type: "tool_use",
    id: "eg1",
    name: "yaad_search_history",
    input: { query: "x" },
  });
  assert.equal(noGrant.isError, true);
  assert.match(noGrant.content, /does not hold yaad_search_history/);

  const refused = await executeTool(runtime.toolContext(retired, "reasoning"), {
    type: "tool_use",
    id: "eg2",
    name: "yaad_search_history",
    input: { query: "x" },
  });
  assert.equal(refused.isError, true);
  assert.equal(refused.content, `retired: agent ${retired} is retired`);
});


test("a failed reasoning wake is reported to the parent and wakes it", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, { id: "failure-parent", systemPrompt: "parent" });
  const childId = await insertAgent(handle.db, {
    id: "failure-child",
    systemPrompt: "child",
    parentAgentId: parentId,
  });
  const conversed: string[] = [];
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({
      reason: async () => {
        throw new Error("Dwar is unreachable");
      },
      converse: async (request) => {
        conversed.push(JSON.stringify(request.messages));
        return yieldTurn();
      },
    }),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  runtime.enqueueReasoning(childId);
  await runtime.waitUntilIdle();

  const sent = await handle.db.select().from(messages).where(eq(messages.fromAgentId, childId));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.toAgentId, parentId);
  assert.ok(sent[0]!.content.includes("Dwar is unreachable"));
  assert.ok(conversed.some((body) => body.includes("Dwar is unreachable")));
});

test("currentRequester is the newest sender other than the agent, skipping runtime reports, else the parent", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, { id: "req-parent", systemPrompt: "parent" });
  const agentId = await insertAgent(handle.db, { id: "req-agent", systemPrompt: "agent", parentAgentId: parentId });
  const askerId = await insertAgent(handle.db, { id: "req-asker", systemPrompt: "asker" });
  const workerId = await insertAgent(handle.db, { id: "req-worker", systemPrompt: "worker", parentAgentId: agentId });
  const send = (fromAgentId: string | null, toAgentId: string | null, content: string) =>
    insertMessage(handle.db, { fromAgentId, toAgentId, content, attachments: NO_ATTACHMENTS });

  assert.equal(await currentRequester(handle.db, agentId), parentId);
  await send(null, agentId, "check my email");
  assert.equal(await currentRequester(handle.db, agentId), null);
  await send(askerId, agentId, "find me a browser");
  await send(agentId, agentId, "note to self");
  await send(workerId, agentId, "[runtime] My reasoning lane failed");
  assert.equal(await currentRequester(handle.db, agentId), askerId);
});

test("a failed conversation lane is reported to its current requester with a runtime_report marker", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, { id: "conv-failure-parent", systemPrompt: "parent" });
  const childId = await insertAgent(handle.db, {
    id: "conv-failure-child",
    systemPrompt: "child",
    parentAgentId: parentId,
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({
      converse: async (request) => {
        if (request.system.includes(`Your agent id is ${childId}.`)) {
          throw new Error("quota exceeded");
        }
        return yieldTurn();
      },
    }),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: mockNas(),
    config,
    log: silentLog,
  });

  await deliverUserMessage(
    { db: handle.db, transcript: runtime.transcript, events: runtime.events, enqueueConversation: runtime.enqueueConversation },
    childId,
    "status?",
  );
  await runtime.waitUntilIdle();

  const sent = await handle.db.select().from(messages).where(eq(messages.fromAgentId, childId));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.toAgentId, null);
  assert.match(sent[0]!.content, /^\[runtime\] My conversation lane failed .*quota exceeded/);
  const logs = await handle.db
    .select()
    .from(agentLogs)
    .where(and(eq(agentLogs.agentId, childId), eq(agentLogs.event, "message")));
  const report = logs.find((log) => log.payload.direction === "send");
  assert.equal(report?.payload[RUNTIME_REPORT], "lane_failed");
});

test("queued steers for a missing agent end the reasoning wake instead of re-queuing it", { timeout: 10_000 }, async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const dwar = mockDwar({});
  const runtime = createRuntime({ db: handle.db, dwar, ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(), yaad: mockYaad(), config, log: silentLog });
  runtime.steer.append("ghost-agent", "keep going");
  runtime.enqueueReasoning("ghost-agent");
  await runtime.waitUntilIdle();

  assert.equal(dwar.reasoningCalls.length, 0);
  assert.equal(runtime.steer.hasItems("ghost-agent"), true);
});

test("a lane logs each model turn whole before its tools run, and each result with its tool name", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, { name: "log-shape", systemPrompt: "work", tools: [] });
  let turn = 0;
  const dwar = mockDwar({
    reason: async () => {
      turn += 1;
      if (turn === 1) {
        return {
          ...toolUse(LIST_AGENTS, {}, "la-1"),
          content: [
            { type: "thinking", thinking: "who is my parent?", signature: "sig-1" },
            { type: "text", text: "Listing agents to find the parent." },
            { type: "tool_use", id: "la-1", name: LIST_AGENTS, input: {} },
          ],
        };
      }
      if (turn === 2) {
        return endTurn("No parent needed; done.");
      }
      return yieldTurn("log-yield");
    },
  });
  const runtime = createRuntime({ db: handle.db, dwar, ghar: mockGhar(), chaavi: mockChaavi(), nas: mockNas(), yaad: mockYaad(), config, log: silentLog });
  runtime.enqueueReasoning(workerId);
  await runtime.waitUntilIdle();

  assert.ok(dwar.reasoningCalls.every((request) => request.tool_choice === "auto"));
  const rows = await handle.db
    .select()
    .from(agentLogs)
    .where(eq(agentLogs.agentId, workerId))
    .orderBy(asc(agentLogs.createdAt));
  assert.deepEqual(
    rows.map((row) => row.event),
    ["response", "tool_result", "response", "response", "tool_result"],
  );
  const first = rows[0]!.payload as { provider: string; content: Array<{ type: string }> };
  assert.equal(first.provider, "anthropic");
  assert.deepEqual(first.content.map((block) => block.type), ["thinking", "text", "tool_use"]);
  const result = rows[1]!.payload as { tool_use_id: string; name: string; is_error: boolean };
  assert.equal(result.tool_use_id, "la-1");
  assert.equal(result.name, LIST_AGENTS);
  assert.equal(result.is_error, false);
});
