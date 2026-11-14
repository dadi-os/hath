import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { convertScheduledMessages } from "../src/db/convert-schedules.js";
import { migrate } from "../src/db/migrate.js";
import { jobs, messages, reminders, routines } from "../src/db/schema.js";
import { createRuntime } from "../src/runtime/engine.js";
import { deliverUserMessage } from "../src/runtime/deliver.js";
import { executeTool } from "../src/runtime/tools.js";
import { setRoutine } from "../src/tools/hath/set-routine.js";
import type { DwarChatRequest } from "../src/types/domain.js";
import { FLAGS_OFF, insertAgent, mockDwar, mockGhar, mockNas, mockYaad, openTestDb, resetRuntime, silentLog, testConfig, withRuntime } from "./helpers.js";

const config = withRuntime(testConfig(), FLAGS_OFF);
const handle = await openTestDb();

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

function harness(work?: (request: DwarChatRequest) => void) {
  const dwar = mockDwar({
    work: (request) => {
      work?.(request);
      return { provider: "anthropic", content: [{ type: "tool_use", id: "y", name: "yield", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    },
  });
  const runtime = createRuntime({ db: handle.db, dwar, yaad: mockYaad(), ghar: mockGhar(), nas: mockNas(), config, log: silentLog });
  return { runtime, dwar };
}

/** The text of every user turn of a request, one per entry. */
function turnTexts(request: DwarChatRequest): string[] {
  return request.messages.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
}

const call = (name: string, input: unknown) => ({ type: "tool_use" as const, id: `${name}-1`, name, input });

test("set_routine has no recipient: its schema holds a title, a procedure, a time and weekdays only", () => {
  assert.deepEqual(Object.keys((setRoutine.inputSchema as { properties: object }).properties).sort(), ["at", "days", "procedure", "title"]);
});

test("set_routine twice with one title leaves one row, changed; a bad time or weekday is an error", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "routine-owner", systemPrompt: "owner" });
  const { runtime } = harness();
  const ctx = runtime.toolContext(agentId, "work");

  const first = await executeTool(ctx, call("set_routine", { title: "Morning due check", procedure: "Read D2L.", at: "07:00" }));
  assert.equal(first.isError, false, first.content);
  assert.equal(JSON.parse(first.content).cadence, "daily 7:00 AM");
  const second = await executeTool(ctx, call("set_routine", { title: "Morning due check", procedure: "Read D2L and Kritik.", at: "07:30", days: ["mon", "fri"] }));
  assert.equal(second.isError, false, second.content);

  const rows = await handle.db.select().from(routines).where(eq(routines.agentId, agentId));
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]?.procedure, rows[0]?.atLocal, rows[0]?.days, rows[0]?.active], ["Read D2L and Kritik.", "07:30", ["mon", "fri"], true]);
  assert.ok(rows[0]!.nextRunAt.getTime() > Date.now());

  assert.equal((await executeTool(ctx, call("set_routine", { title: "Bad", procedure: "x", at: "7am" }))).isError, true);
  assert.equal((await executeTool(ctx, call("set_routine", { title: "Bad", procedure: "x", at: "07:00", days: ["monday"] }))).isError, true);
  assert.equal((await executeTool(ctx, call("set_routine", { title: "Bad", procedure: "x", at: "07:00", to_agent_id: "other" }))).isError, true, "a recipient cannot be expressed");

  const ended = await executeTool(ctx, call("end_routine", { title: "Morning due check" }));
  assert.equal(ended.isError, false, ended.content);
  assert.equal((await executeTool(ctx, call("end_routine", { title: "Morning due check" }))).isError, true, "ending twice finds nothing");
  const [stopped] = await handle.db.select().from(routines).where(eq(routines.agentId, agentId));
  assert.equal(stopped?.active, false);
  await runtime.waitUntilIdle();
});

test("any agent can read another's routines, and only its own are changed", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const ownerId = await insertAgent(handle.db, { id: "routine-owner", systemPrompt: "owner" });
  const readerId = await insertAgent(handle.db, { id: "routine-reader", systemPrompt: "reader" });
  const { runtime } = harness();
  await executeTool(runtime.toolContext(ownerId, "work"), call("set_routine", { title: "Weekly", procedure: "Do it.", at: "13:00", days: ["sun"] }));
  const read = await executeTool(runtime.toolContext(readerId, "work"), call("list_routines", { agent_id: ownerId }));
  assert.equal(read.isError, false, read.content);
  assert.deepEqual(JSON.parse(read.content).routines.map((row: { title: string }) => row.title), ["Weekly"]);
  assert.deepEqual(JSON.parse((await executeTool(runtime.toolContext(readerId, "work"), call("list_routines", {}))).content).routines, []);
  assert.equal((await executeTool(runtime.toolContext(readerId, "work"), call("end_routine", { title: "Weekly" }))).isError, true);
  await runtime.waitUntilIdle();
});

test("a due routine opens a job of its own with no requester, wakes the work lane with its procedure, and closes its previous run", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "routine-runner", systemPrompt: "runner" });
  const setUpById = await insertAgent(handle.db, { id: "routine-author", systemPrompt: "author" });
  const requests: DwarChatRequest[] = [];
  const { runtime } = harness((request) => requests.push(structuredClone(request)));
  const [routine] = await handle.db
    .insert(routines)
    .values({
      id: "00000000-0000-4000-8000-0000000000a1",
      agentId,
      title: "Morning due check",
      procedure: "Read D2L and record what is due.",
      atLocal: "07:00",
      days: null,
      nextRunAt: new Date(Date.now() - 1_000),
      active: true,
      setUpBy: setUpById,
    })
    .returning();

  await runtime.scheduler.tick(new Date());
  await runtime.waitUntilIdle();

  const [first] = await handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
  assert.equal(first?.requesterId, agentId, "no one asked");
  assert.equal(first?.routineId, routine!.id);
  assert.equal(first?.answerBy, null);
  const [after1] = await handle.db.select().from(routines).where(eq(routines.id, routine!.id));
  assert.equal(after1?.lastJobId, first?.id);
  assert.equal(after1?.setUpBy, null, "the one-time line is said once");
  assert.ok(after1!.nextRunAt.getTime() > Date.now());
  const [notice] = await handle.db.select().from(messages).where(eq(messages.jobId, first!.id));
  assert.equal(notice?.kind, "notice");
  assert.match(notice!.content, /set up for you by routine-author; change it with set_routine/);

  const texts = turnTexts(requests[0]!).join("\n");
  assert.match(texts, new RegExp(`\\[Wake\\] your routine "Morning due check" · job #${first!.openedSeq} \\(routine, no requester\\)`));
  assert.match(texts, /\[Routine "Morning due check"\] yours · daily 7:00 AM · first run\nRead D2L and record what is due\./);
  assert.doesNotMatch(texts, /\[From: routine-author/);

  await handle.db.update(routines).set({ nextRunAt: new Date(Date.now() - 1_000) }).where(eq(routines.id, routine!.id));
  await runtime.scheduler.tick(new Date());
  await runtime.waitUntilIdle();
  const all = await handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
  assert.equal(all.length, 2);
  assert.equal(all.find((row) => row.id === first!.id)?.state, "done", "the previous run is closed");
  assert.match(turnTexts(requests.at(-1)!).join("\n"), /last run [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2} [AP]M \(stored 0, sent 0\)/);
});

test("remind_me fires into its job and returns a done job to open; it needs a job and a future time", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "reminder-agent", systemPrompt: "agent" });
  const requests: DwarChatRequest[] = [];
  const { runtime } = harness((request) => requests.push(structuredClone(request)));

  const outside = await executeTool(runtime.toolContext(agentId, "work"), call("remind_me", { at: new Date(Date.now() + 3_600_000).toISOString(), note: "x" }));
  assert.equal(outside.isError, true, "no wake, so no job");

  await deliverUserMessage(runtime.deliver, agentId, "remind me Friday to call mom");
  await runtime.waitUntilIdle();
  const [job] = await handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
  const ctx = { ...runtime.toolContext(agentId, "work"), jobId: job!.id };
  assert.equal((await executeTool(ctx, call("remind_me", { at: new Date(Date.now() - 1_000).toISOString(), note: "past" }))).isError, true);
  const set = await executeTool(ctx, call("remind_me", { at: new Date(Date.now() + 3_600_000).toISOString(), note: "call mom" }));
  assert.equal(set.isError, false, set.content);
  await handle.db.update(jobs).set({ state: "done" }).where(eq(jobs.id, job!.id));

  requests.length = 0;
  await runtime.scheduler.tick(new Date(Date.now() + 7_200_000));
  await runtime.waitUntilIdle();
  assert.equal((await handle.db.select().from(reminders)).length, 0, "it fires once");
  assert.equal((await handle.db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]?.state, "open");
  const texts = turnTexts(requests[0]!).join("\n");
  assert.match(texts, new RegExp(`\\[Wake\\] your reminder · job #${job!.openedSeq} \\(continues\\)`));
  assert.match(texts, /opened by Ankur/);
  assert.match(texts, /\[Reminder\] call mom/);
});

test("a one-shot that had no job opens one whose requester is its author, or no one's when it was its own", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const authorId = await insertAgent(handle.db, { id: "reminder-author", systemPrompt: "author" });
  const agentId = await insertAgent(handle.db, { id: "reminder-target", systemPrompt: "target" });
  const { runtime } = harness();
  const past = new Date(Date.now() - 1_000);
  await handle.db.insert(reminders).values([
    { id: "00000000-0000-4000-8000-0000000000b1", agentId, authorId, note: "from the author", runAt: past },
    { id: "00000000-0000-4000-8000-0000000000b2", agentId, authorId: agentId, note: "from itself", runAt: past },
  ]);
  await runtime.scheduler.tick(new Date());
  await runtime.waitUntilIdle();
  const made = await handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
  assert.deepEqual(made.map((row) => row.requesterId).sort(), [authorId, agentId].sort());
});

test("scheduled messages convert to routines and reminders, keep their next fire time, and the table is backed up and dropped", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const eduId = await insertAgent(handle.db, { id: "education-specialist", systemPrompt: "edu" });
  const classId = await insertAgent(handle.db, { id: "cse-300-specialist", systemPrompt: "class", parentAgentId: eduId });
  await handle.sql`DROP TABLE IF EXISTS scheduled_messages_backup_20261114`;
  await handle.sql`DROP TABLE IF EXISTS scheduled_messages`;
  await handle.sql`CREATE TABLE scheduled_messages (id uuid PRIMARY KEY, from_agent_id text NOT NULL, to_agent_id text NOT NULL, content text NOT NULL, run_at timestamptz NOT NULL, interval_minutes integer, created_at timestamptz NOT NULL DEFAULT now())`;
  const insert = (id: string, from: string, to: string, content: string, runAt: string, interval: number | null, created: string) =>
    handle.sql`INSERT INTO scheduled_messages (id, from_agent_id, to_agent_id, content, run_at, interval_minutes, created_at) VALUES (${id}, ${from}, ${to}, ${content}, ${runAt}, ${interval}, ${created})`;
  await insert("00000000-0000-4000-8000-000000000001", eduId, eduId, "School email triage\nRead the inbox.", "2026-11-14T12:30:00Z", 1440, "2026-11-01T00:00:00Z");
  await insert("00000000-0000-4000-8000-000000000002", eduId, classId, "Sunday site check\nRead D2L.", "2026-11-15T18:00:00Z", 10080, "2026-11-01T00:00:01Z");
  await insert("00000000-0000-4000-8000-000000000003", eduId, classId, "Sunday site check\nAlso Kritik.", "2026-11-15T18:00:00Z", 10080, "2026-11-01T00:00:02Z");
  await insert("00000000-0000-4000-8000-000000000004", eduId, classId, "Call the advisor", "2026-11-20T15:00:00Z", null, "2026-11-01T00:00:03Z");

  assert.deepEqual(await convertScheduledMessages(handle.db, "America/Detroit"), { routines: 3, reminders: 1 });

  const edu = await handle.db.select().from(routines).where(eq(routines.agentId, eduId));
  assert.deepEqual(edu.map((row) => [row.title, row.atLocal, row.days, row.setUpBy, row.nextRunAt.toISOString()]), [["School email triage", "07:30", null, null, "2026-11-14T12:30:00.000Z"]]);
  const cls = (await handle.db.select().from(routines).where(eq(routines.agentId, classId))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  assert.deepEqual(cls.map((row) => [row.title, row.atLocal, row.days, row.setUpBy]), [
    ["Sunday site check", "13:00", ["sun"], eduId],
    ["Sunday site check (2)", "13:00", ["sun"], eduId],
  ]);
  const [reminder] = await handle.db.select().from(reminders);
  assert.deepEqual([reminder?.agentId, reminder?.authorId, reminder?.jobId, reminder?.note], [classId, eduId, null, "Call the advisor"]);

  assert.equal((await handle.sql`SELECT count(*)::int AS n FROM scheduled_messages_backup_20261114`)[0]?.n, 4);
  assert.equal((await handle.sql`SELECT to_regclass('scheduled_messages') AS found`)[0]?.found, null);
  assert.equal(await convertScheduledMessages(handle.db, "America/Detroit"), null, "nothing left to convert");
  await handle.sql`DROP TABLE scheduled_messages_backup_20261114`;
});

test("a repeating message that is not daily or weekly cannot be a routine: the conversion throws and changes nothing", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "hourly-agent", systemPrompt: "agent" });
  await handle.sql`DROP TABLE IF EXISTS scheduled_messages`;
  await handle.sql`CREATE TABLE scheduled_messages (id uuid PRIMARY KEY, from_agent_id text NOT NULL, to_agent_id text NOT NULL, content text NOT NULL, run_at timestamptz NOT NULL, interval_minutes integer, created_at timestamptz NOT NULL DEFAULT now())`;
  await handle.sql`INSERT INTO scheduled_messages (id, from_agent_id, to_agent_id, content, run_at, interval_minutes) VALUES ('00000000-0000-4000-8000-000000000009', ${agentId}, ${agentId}, 'Every hour', now(), 60)`;
  await assert.rejects(convertScheduledMessages(handle.db, "America/Detroit"), /every 60 minutes/);
  assert.equal((await handle.sql`SELECT count(*)::int AS n FROM scheduled_messages`)[0]?.n, 1);
  assert.equal((await handle.db.select().from(routines)).length, 0);
  await handle.sql`DROP TABLE scheduled_messages`;
});
