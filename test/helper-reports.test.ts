import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "../src/db/migrate.js";
import { attachments, deliveredReports, watches } from "../src/db/schema.js";
import type { HelperReport } from "../src/nas/client.js";
import { createRuntime } from "../src/runtime/engine.js";
import { insertAgent, mockDwar, mockGhar, mockNas, mockYaad, openTestDb, resetRuntime, silentLog, testConfig, yieldTurn } from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

function report(overrides: Partial<HelperReport> = {}): HelperReport {
  return {
    seq: 1,
    task: "task/browser/1",
    kind: "browser",
    id: "1",
    agent_id: "reporter",
    state: "done",
    text: "Applied to 3 roles.",
    files: [],
    at: "2026-10-29T14:00:00.000000000Z",
    ...overrides,
  };
}

function taskWith(last: HelperReport) {
  return {
    task: last.task,
    kind: last.kind,
    id: last.id,
    owner: "reporter",
    steered_by: "reporter",
    purpose: "p",
    status: "idle" as const,
    state: "",
    created_at: last.at,
    last_activity: last.at,
    last_report: last,
  };
}

function harness() {
  const nas = mockNas({});
  const dwar = mockDwar({ work: () => yieldTurn() });
  const runtime = createRuntime({ db: handle.db, dwar, yaad: mockYaad(), ghar: mockGhar(), nas, config, log: silentLog });
  return { nas, dwar, runtime };
}

const notices = (runtime: ReturnType<typeof harness>["runtime"]) =>
  runtime.transcript.transcriptFor("reporter").filter((row) => row.kind === "notice");

test("a helper report reaches the owning agent as a notice and wakes its work lane, even though it was idle", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "reporter", systemPrompt: "reports" });
  const { dwar, runtime } = harness();

  await runtime.helperReports.handle(report());
  await runtime.waitUntilIdle();

  const arrived = notices(runtime).at(-1);
  assert.equal(arrived?.fromAgentId, "reporter");
  assert.equal(arrived?.toAgentId, "reporter");
  assert.equal(arrived?.content, "Helper finished (task/browser/1):\nApplied to 3 roles.");
  assert.equal(dwar.workCalls.length, 1, "the work lane ran for it");
  assert.equal(dwar.processCalls.length, 0, "the process lane did not");
  const first = JSON.stringify(dwar.workCalls[0]!.messages);
  assert.match(first, /Woken by: helper result from task\/browser\/1/);
  assert.match(first, /Applied to 3 roles\./);
});

test("a report delivered twice, by the stream and by reconcile, is one message", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "reporter", systemPrompt: "reports" });
  const { nas, runtime } = harness();
  nas.tasks.set("task/browser/1", taskWith(report()));

  await runtime.helperReports.handle(report());
  await runtime.helperReports.reconcile();
  await runtime.helperReports.handle(report());
  await runtime.waitUntilIdle();

  assert.equal(notices(runtime).length, 1);
  const [mark] = await handle.db.select().from(deliveredReports).where(eq(deliveredReports.task, "task/browser/1"));
  assert.equal(mark?.deliveredAt.toISOString(), "2026-10-29T14:00:00.000Z");
});

test("after Nas restarts its numbering, a newer report with a lower seq is still delivered", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "reporter", systemPrompt: "reports" });
  const { runtime } = harness();

  await runtime.helperReports.handle(report({ seq: 9, text: "first" }));
  await runtime.helperReports.handle(report({ seq: 1, text: "second", at: "2026-10-30T09:00:00.000000000Z" }));
  await runtime.waitUntilIdle();

  assert.deepEqual(
    notices(runtime).map((row) => row.content),
    ["Helper finished (task/browser/1):\nfirst", "Helper finished (task/browser/1):\nsecond"],
  );
});

test("reconcile after boot delivers the last report of every task that has none delivered, oldest first", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "reporter", systemPrompt: "reports" });
  const { nas, runtime } = harness();
  const later = report({ task: "task/terminal/2", kind: "terminal", id: "2", text: "built", at: "2026-10-29T15:00:00.000000000Z" });
  for (const last of [later, report({ text: "applied" })]) {
    nas.tasks.set(last.task, taskWith(last));
  }

  await runtime.helperReports.reconcile();
  await runtime.waitUntilIdle();

  assert.deepEqual(
    notices(runtime).map((row) => row.content),
    ["Helper finished (task/browser/1):\napplied", "Helper finished (task/terminal/2):\nbuilt"],
  );
});

test("a report's files arrive as attachments, and one that cannot be attached is named in the message", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "reporter", systemPrompt: "reports" });
  const { nas, runtime } = harness();
  nas.files.set("/var/home/dadi/Downloads/receipt.pdf", Buffer.from("%PDF-1.4"));

  await runtime.helperReports.handle(
    report({ files: ["/var/home/dadi/Downloads/receipt.pdf", "/var/home/dadi/Downloads/gone.pdf"] }),
  );
  await runtime.waitUntilIdle();

  const notice = notices(runtime)[0]!;
  assert.deepEqual(notice.attachments.map((file) => file.filename), ["receipt.pdf"]);
  assert.match(notice.content, /gone\.pdf could not be attached: /);
  assert.equal((await handle.db.select().from(attachments)).length, 1);
});

test("a needs_input report and a failure say so, and a report for a missing agent is dropped but marked", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "reporter", systemPrompt: "reports" });
  const { runtime } = harness();

  await runtime.helperReports.handle(report({ state: "needs_input", text: "What is the code?" }));
  await runtime.helperReports.handle(report({ state: "failed", text: "Blocked.", at: "2026-10-29T14:05:00.000000000Z" }));
  await runtime.helperReports.handle(report({ task: "task/browser/9", id: "9", agent_id: "nobody" }));
  await runtime.waitUntilIdle();

  assert.deepEqual(
    notices(runtime).map((row) => row.content),
    ["Helper needs something from you (task/browser/1):\nWhat is the code?", "Helper failed (task/browser/1):\nBlocked."],
  );
  const marked = await handle.db.select().from(deliveredReports).where(eq(deliveredReports.task, "task/browser/9"));
  assert.equal(marked.length, 1);
});

test("the stream is followed: a pushed report is delivered, and a dropped stream reconnects and reconciles", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "reporter", systemPrompt: "reports" });
  const { nas, runtime } = harness();

  runtime.helperReports.start();
  try {
    await waitFor(() => nas.streamOpen());
    nas.emit({ type: "helper_report", report: report() });
    await waitFor(() => notices(runtime).length === 1);

    const missed = report({ text: "while disconnected", at: "2026-10-29T16:00:00.000000000Z" });
    nas.tasks.set(missed.task, taskWith(missed));
    nas.dropStream(new Error("connection reset"));
    await waitFor(() => nas.opens() >= 2, 5_000);
    await waitFor(() => notices(runtime).length === 2, 5_000);
  } finally {
    runtime.helperReports.stop();
    await runtime.waitUntilIdle();
  }
});

test("a report clears the watch the agent had on its task", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  await insertAgent(handle.db, { id: "reporter", systemPrompt: "reports" });
  const { runtime } = harness();
  await handle.db.insert(watches).values({ agentId: "reporter", targets: ["task/browser/1"], dueAt: new Date(Date.now() + 60_000) });

  await runtime.helperReports.handle(report());
  await runtime.waitUntilIdle();

  assert.equal((await handle.db.select().from(watches)).length, 0);
});

async function waitFor(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
