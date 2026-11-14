import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { migrate } from "../src/db/migrate.js";
import { agentActivity, jobs, messages } from "../src/db/schema.js";
import { deliverUserMessage } from "../src/runtime/deliver.js";
import { createRuntime } from "../src/runtime/engine.js";
import { replyWithText } from "../src/runtime/send.js";
import { executeTool } from "../src/runtime/tools.js";
import { FLAGS_OFF, insertAgent, mockDwar, mockGhar, mockNas, mockYaad, openTestDb, resetRuntime, silentLog, testConfig, withRuntime } from "./helpers.js";

const config = withRuntime(testConfig(), FLAGS_OFF);
const handle = await openTestDb();

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

function harness() {
  return createRuntime({ db: handle.db, dwar: mockDwar({}), yaad: mockYaad(), ghar: mockGhar(), nas: mockNas(), config, log: silentLog });
}

const send = (name: string, input: unknown) => ({ type: "tool_use" as const, id: "send-1", name, input });

/** An agent with Ankur's open job, and a work-lane tool context standing in that job. */
async function inAnkursJob(id: string) {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id, systemPrompt: "agent" });
  const runtime = harness();
  await deliverUserMessage(runtime.deliver, agentId, "what is due Nov 11?");
  await runtime.waitUntilIdle();
  const [job] = await handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
  return { agentId, runtime, job: job!, ctx: { ...runtime.toolContext(agentId, "work"), jobId: job!.id } };
}

test("requester addresses whoever gave the job; a status closes it; a date to Ankur gets its weekday; the send is recorded as activity", async () => {
  const { agentId, runtime, job, ctx } = await inAnkursJob("sender-agent");
  const result = await executeTool(ctx, send("send_message", { to: "requester", content: 'HW3 is due Nov 11. The task "Quiz Nov 14" is separate.', status: "done" }));
  assert.equal(result.isError, false, result.content);
  const [row] = await handle.db.select().from(messages).where(and(eq(messages.fromAgentId, agentId), eq(messages.kind, "message")));
  assert.match(row!.content, /^HW3 is due (Mon|Tue|Wed|Thu|Fri|Sat|Sun) Nov 11\. The task "Quiz Nov 14" is separate\.$/);
  assert.equal(row?.toAgentId, null);
  assert.equal(row?.status, "done");
  assert.equal(row?.jobId, job.id);
  assert.equal((await handle.db.select().from(jobs).where(eq(jobs.id, job.id)))[0]?.state, "done");
  const [activity] = await handle.db.select().from(agentActivity).where(eq(agentActivity.agentId, agentId));
  assert.deepEqual([activity?.kind, activity?.subject, activity?.jobId], ["send", "ankur", job.id]);
  await runtime.waitUntilIdle();
});

test("running is not a status a message can carry", async () => {
  const { runtime, ctx, agentId } = await inAnkursJob("running-agent");
  const result = await executeTool(ctx, send("send_message", { to: "ankur", content: "Working on it.", status: "running" }));
  assert.equal(result.isError, true);
  assert.equal((await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId))).length, 0);
  await runtime.waitUntilIdle();
});

test("an address that cannot be delivered to is an error: no job for requester, itself, a retired agent", async () => {
  const { runtime, agentId, ctx } = await inAnkursJob("address-agent");
  const outside = runtime.toolContext(agentId, "work");
  assert.match((await executeTool(outside, send("send_message", { to: "requester", content: "x" }))).content, /no job/);
  assert.match((await executeTool(ctx, send("send_message", { to: agentId, content: "x" }))).content, /yourself/);
  const retiredId = await insertAgent(handle.db, { id: "retired-peer", systemPrompt: "peer" });
  await handle.sql`UPDATE agents SET active = false WHERE id = ${retiredId}`;
  assert.equal((await executeTool(ctx, send("send_message", { to: retiredId, content: "x" }))).isError, true);
  await runtime.waitUntilIdle();
});

test("a message to an agent is not refused for anything it says, and it is an ask unless that agent is the requester", async () => {
  const { runtime, agentId, ctx } = await inAnkursJob("ask-agent");
  const peerId = await insertAgent(handle.db, { id: "ask-peer", systemPrompt: "peer" });
  const result = await executeTool(ctx, send("send_message", { to: peerId, content: "Working on it. Due Mon Nov 11, what is open?" }));
  assert.equal(result.isError, false, result.content);
  const body = JSON.parse(result.content) as { ask: boolean };
  assert.equal(body.ask, true);
  const [row] = await handle.db.select().from(messages).where(and(eq(messages.fromAgentId, agentId), eq(messages.toAgentId, peerId)));
  assert.equal(row?.content, "Working on it. Due Mon Nov 11, what is open?", "agents get no weekday rewriting");
  const toRequester = JSON.parse((await executeTool(ctx, send("send_message", { to: "ankur", content: "Asked the class." }))).content) as { ask: boolean };
  assert.equal(toRequester.ask, false);
  await runtime.waitUntilIdle();
});

test("a turn of text is the answer: one message marked done in a job that is owed one, silent in a routine, thought otherwise", async () => {
  const { runtime, agentId, job, ctx } = await inAnkursJob("text-agent");
  assert.equal(await replyWithText(ctx, "Nothing is due tonight."), true);
  const sent = await handle.db.select().from(messages).where(and(eq(messages.fromAgentId, agentId), eq(messages.kind, "message")));
  assert.deepEqual(sent.map((row) => [row.content, row.status, row.jobId]), [["Nothing is due tonight.", "done", job.id]]);
  assert.equal(await replyWithText(ctx, "And one more thing."), false, "the requester already has its answer");
  assert.equal((await handle.db.select().from(messages).where(and(eq(messages.fromAgentId, agentId), eq(messages.kind, "message")))).length, 1);

  assert.equal(await replyWithText({ ...ctx, jobId: null }, "thinking"), false, "no job, so only thought");

  const [routine] = await handle.db.insert(jobs).values({ id: "00000000-0000-4000-8000-0000000000c1", requesterId: agentId, agentId, state: "open", openedSeq: 1, routineId: "00000000-0000-4000-8000-0000000000c2" }).returning();
  assert.equal(await replyWithText({ ...ctx, jobId: routine!.id }, "Checked; nothing new."), true, "a routine's text ends the wake");
  assert.equal((await handle.db.select().from(messages).where(and(eq(messages.fromAgentId, agentId), eq(messages.kind, "message")))).length, 1, "and reaches no one");
  const toRoutineRequester = await executeTool({ ...ctx, jobId: routine!.id }, send("send_message", { to: "requester", content: "x" }));
  assert.match(toRoutineRequester.content, /nobody asked/);
  await runtime.waitUntilIdle();
});
