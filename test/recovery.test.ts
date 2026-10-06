import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "../src/db/migrate.js";
import { agentLogs, agents, messages } from "../src/db/schema.js";
import { RUNTIME_REPORT } from "../src/runtime/deliver.js";
import { EventBus } from "../src/runtime/events.js";
import { recoverInterruptedWakes } from "../src/runtime/recovery.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import type { Lane, LogEvent } from "../src/types/domain.js";
import { insertAgent, openTestDb, resetRuntime, silentLog, testConfig } from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

/** seedLog writes one audit row `secondsAgo` before now, so rows sort in the order a test lists them. */
async function seedLog(
  agentId: string,
  lane: Lane,
  event: LogEvent,
  payload: Record<string, unknown>,
  secondsAgo: number,
): Promise<void> {
  await handle.db.insert(agentLogs).values({
    id: randomUUID(),
    agentId,
    lane,
    event,
    payload,
    createdAt: new Date(Date.now() - secondsAgo * 1000),
  });
}

test("boot recovery reports a wake cut mid-tool once, wakes a waiting message, and leaves finished and retired agents alone", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, { id: "recovery-parent", systemPrompt: "parent" });
  const cutId = await insertAgent(handle.db, { id: "recovery-cut", systemPrompt: "cut", parentAgentId: parentId });
  const waitingId = await insertAgent(handle.db, { id: "recovery-waiting", systemPrompt: "waiting" });
  const doneId = await insertAgent(handle.db, { id: "recovery-done", systemPrompt: "done" });
  const retiredId = await insertAgent(handle.db, { id: "recovery-retired", systemPrompt: "retired" });
  await handle.db.update(agents).set({ active: false }).where(eq(agents.id, retiredId));

  await seedLog(cutId, "conversation", "message", { direction: "receive", content: "click it" }, 60);
  await seedLog(cutId, "conversation", "response", { content: [] }, 59);
  await seedLog(cutId, "conversation", "tool_result", { name: "steer_reasoning", is_error: false, content: '{"queued":true,"terminate":false}' }, 58);
  await seedLog(cutId, "conversation", "tool_result", { name: "yield", is_error: false, content: '{"yielded":true}' }, 57);
  await seedLog(
    cutId,
    "reasoning",
    "response",
    { content: [{ type: "tool_use", id: "c1", name: "browser_click", input: { ref: "e1" } }] },
    56,
  );

  await seedLog(waitingId, "conversation", "message", { direction: "receive", content: "hello?" }, 30);

  await seedLog(doneId, "conversation", "message", { direction: "receive", content: "hi" }, 20);
  await seedLog(doneId, "conversation", "response", { content: [] }, 19);
  await seedLog(doneId, "conversation", "tool_result", { name: "yield", is_error: false, content: '{"yielded":true}' }, 18);

  await seedLog(retiredId, "conversation", "message", { direction: "receive", content: "too late" }, 10);

  const woken: string[] = [];
  const deps = {
    db: handle.db,
    transcript: new TranscriptStore(),
    events: new EventBus(silentLog),
    enqueueConversation: (agentId: string) => {
      woken.push(agentId);
    },
    log: silentLog,
  };
  await recoverInterruptedWakes(deps);

  const reports = await handle.db.select().from(messages).where(eq(messages.fromAgentId, cutId));
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.toAgentId, parentId);
  assert.match(reports[0]!.content, /^\[runtime\] Hath restarted/);
  assert.match(reports[0]!.content, /started browser_click .* may or may not have run/);
  const [sendLog] = await handle.db
    .select()
    .from(agentLogs)
    .where(eq(agentLogs.agentId, cutId))
    .then((rows) => rows.filter((row) => row.event === "message" && row.payload.direction === "send"));
  assert.equal(sendLog?.payload[RUNTIME_REPORT], "wake_interrupted");
  assert.deepEqual(woken.sort(), [parentId, waitingId].sort());

  woken.length = 0;
  await recoverInterruptedWakes(deps);
  const again = await handle.db.select().from(messages).where(eq(messages.fromAgentId, cutId));
  assert.equal(again.length, 1);
  assert.deepEqual(woken.sort(), [parentId, waitingId].sort());
});
