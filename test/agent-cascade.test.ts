import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq, inArray, or } from "drizzle-orm";
import { migrate } from "../src/db/migrate.js";
import {
  agentLogs,
  agents,
  messages,
  scheduledMessages,
} from "../src/db/schema.js";
import { insertAgent, openTestDb, resetRuntime, testConfig } from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

test("deleting an agent deletes its subtree and every row naming it", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const manager = await insertAgent(handle.db, { id: "doomed-manager", systemPrompt: "manage" });
  const worker = await insertAgent(handle.db, {
    id: "doomed-worker",
    systemPrompt: "work",
    parentAgentId: manager,
  });
  const grandchild = await insertAgent(handle.db, {
    id: "doomed-grandchild",
    systemPrompt: "help",
    parentAgentId: worker,
  });
  const bystander = await insertAgent(handle.db, { id: "bystander", systemPrompt: "watch" });

  await handle.db.insert(agentLogs).values({
    id: randomUUID(),
    agentId: grandchild,
    lane: "work",
    event: "message",
    payload: {},
  });
  await handle.db.insert(messages).values([
    { id: randomUUID(), fromAgentId: bystander, toAgentId: worker, content: "to the subtree" },
    { id: randomUUID(), fromAgentId: grandchild, toAgentId: null, content: "to Ankur" },
    { id: randomUUID(), fromAgentId: null, toAgentId: bystander, content: "kept" },
  ]);
  await handle.db.insert(scheduledMessages).values({
    id: randomUUID(),
    fromAgentId: bystander,
    toAgentId: grandchild,
    content: "later",
    runAt: new Date(),
    intervalMinutes: null,
  });

  await handle.db.delete(agents).where(eq(agents.id, manager));

  const subtree = [manager, worker, grandchild];
  assert.deepEqual(
    (await handle.db.select({ id: agents.id }).from(agents)).map((row) => row.id),
    [bystander],
  );
  assert.equal((await handle.db.select().from(agentLogs).where(inArray(agentLogs.agentId, subtree))).length, 0);
  assert.equal(
    (
      await handle.db
        .select()
        .from(messages)
        .where(or(inArray(messages.fromAgentId, subtree), inArray(messages.toAgentId, subtree)))
    ).length,
    0,
  );
  assert.equal((await handle.db.select().from(scheduledMessages)).length, 0);
  assert.deepEqual(
    (await handle.db.select({ content: messages.content }).from(messages)).map((row) => row.content),
    ["kept"],
  );
});
