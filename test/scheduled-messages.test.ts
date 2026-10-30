import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { migrate } from "../src/db/migrate.js";
import { scheduledMessages, type ScheduledMessageRow } from "../src/db/schema.js";
import { toScheduledMessageRecord } from "../src/serialize.js";
import { insertAgent, openTestDb, resetRuntime, testConfig } from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

/** Drizzle wraps driver errors; match against the outer message and its cause. */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const cause = err.cause instanceof Error ? err.cause.message : "";
  return `${err.message}\n${cause}`;
}

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

test("scheduled_messages exists with check constraints and run_at index", async () => {
  const checks = await handle.sql`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'scheduled_messages'::regclass
      AND contype = 'c'
    ORDER BY conname
  `;
  assert.deepEqual(
    checks.map((row) => row.conname as string),
    ["scheduled_messages_from_to_check", "scheduled_messages_interval_minutes_check"],
  );

  const indexes = await handle.sql`
    SELECT indexname
    FROM pg_indexes
    WHERE tablename = 'scheduled_messages'
      AND indexname = 'scheduled_messages_run_at_idx'
  `;
  assert.equal(indexes.length, 1);
});

test("from_agent_id = to_agent_id is rejected", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const fromId = await insertAgent(handle.db, {
    name: "scheduler",
    systemPrompt: "schedule work",
  });

  await assert.rejects(
    () =>
      handle.db.insert(scheduledMessages).values({
        id: randomUUID(),
        fromAgentId: fromId,
        toAgentId: fromId,
        content: "self",
        runAt: new Date(),
        intervalMinutes: null,
      }),
    (err: unknown) => {
      assert.match(errorText(err), /scheduled_messages_from_to_check|check constraint/i);
      return true;
    },
  );
});

test("interval_minutes 0 is rejected; 1 and null are accepted", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const fromId = await insertAgent(handle.db, {
    name: "scheduler",
    systemPrompt: "schedule work",
  });
  const toId = await insertAgent(handle.db, {
    name: "scheduled-target",
    systemPrompt: "prompt",
  });

  await assert.rejects(
    () =>
      handle.db.insert(scheduledMessages).values({
        id: randomUUID(),
        fromAgentId: fromId,
        toAgentId: toId,
        content: "bad interval",
        runAt: new Date(),
        intervalMinutes: 0,
      }),
    (err: unknown) => {
      assert.match(
        errorText(err),
        /scheduled_messages_interval_minutes_check|check constraint/i,
      );
      return true;
    },
  );

  await handle.db.insert(scheduledMessages).values({
    id: randomUUID(),
    fromAgentId: fromId,
    toAgentId: toId,
    content: "one-shot",
    runAt: new Date(),
    intervalMinutes: null,
  });

  await handle.db.insert(scheduledMessages).values({
    id: randomUUID(),
    fromAgentId: fromId,
    toAgentId: toId,
    content: "recurring",
    runAt: new Date(),
    intervalMinutes: 1,
  });
});

test("toScheduledMessageRecord round-trips a row to snake_case ISO record", () => {
  const runAt = new Date("2026-09-09T18:00:00.000Z");
  const createdAt = new Date("2026-09-09T12:00:00.000Z");
  const row: ScheduledMessageRow = {
    id: "11111111-1111-4111-8111-111111111111",
    fromAgentId: "22222222-2222-4222-8222-222222222222",
    toAgentId: "33333333-3333-4333-8333-333333333333",
    content: "ping",
    runAt,
    intervalMinutes: 15,
    createdAt,
  };

  assert.deepEqual(toScheduledMessageRecord(row), {
    id: row.id,
    from_agent_id: row.fromAgentId,
    to_agent_id: row.toAgentId,
    content: "ping",
    run_at: "2026-09-09T18:00:00.000Z",
    interval_minutes: 15,
    created_at: "2026-09-09T12:00:00.000Z",
  });

  assert.equal(
    toScheduledMessageRecord({ ...row, intervalMinutes: null }).interval_minutes,
    null,
  );
});
