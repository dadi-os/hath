import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "../src/db/migrate.js";
import { agentLogs, jobs, messages } from "../src/db/schema.js";
import { sendPickups } from "../src/runtime/pickups.js";
import { recordActivity } from "../src/runtime/activity.js";
import { deliverAgentMessage, deliverUserMessage, type DeliverDeps } from "../src/runtime/deliver.js";
import { EventBus } from "../src/runtime/events.js";
import { renderHeader } from "../src/runtime/header.js";
import { jobOfTask, noteSteer } from "../src/runtime/job-of.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import type { WakeOrigin } from "../src/types/domain.js";
import { FLAGS_OFF, insertAgent, openTestDb, resetRuntime, silentLog, testConfig, withRuntime } from "./helpers.js";

const config = withRuntime(testConfig(), FLAGS_OFF);
const handle = await openTestDb();

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

type Woken = { lane: "process" | "work"; agentId: string; origin: WakeOrigin | undefined };

/** Delivery deps that wake no lane and record who would have been woken. */
function deps(): DeliverDeps & { woken: Woken[] } {
  const woken: Woken[] = [];
  return {
    db: handle.db,
    transcript: new TranscriptStore(),
    events: new EventBus(silentLog),
    answerByMinutes: 5,
    woken,
    enqueueProcess: (agentId, _reason, origin) => {
      woken.push({ lane: "process", agentId, origin });
      return randomUUID();
    },
    enqueueWork: (agentId, _reason, origin) => {
      woken.push({ lane: "work", agentId, origin });
      return randomUUID();
    },
  };
}

async function jobsOf(agentId: string) {
  return handle.db.select().from(jobs).where(eq(jobs.agentId, agentId));
}

test("Ankur's message opens a job due five minutes after it, and his next message joins it", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "job-agent", systemPrompt: "agent" });
  const d = deps();

  const first = await deliverUserMessage(d, agentId, "find my exam times");
  const [job] = await jobsOf(agentId);
  assert.equal(job?.state, "open");
  assert.equal(job?.requesterId, null);
  assert.equal(job?.openedSeq, first.seq);
  const dueIn = job!.answerBy!.getTime() - first.createdAt.getTime();
  assert.ok(Math.abs(dueIn - 5 * 60_000) < 10_000, `answer-by is five minutes after his message, got ${dueIn} ms`);
  const [stamped] = await handle.db.select().from(messages).where(eq(messages.id, first.id!));
  assert.equal(stamped?.jobId, job?.id);
  assert.equal(d.woken[0]?.origin?.jobId, job?.id);
  assert.equal(d.woken[0]?.origin?.jobIsNew, true);

  await deliverUserMessage(d, agentId, "and my quiz times");
  assert.equal((await jobsOf(agentId)).length, 1, "a second message from the requester joins the open job");
  assert.equal(d.woken[1]?.origin?.jobIsNew, false);
});

test("a message from an agent opens a job with no answer-by, and a status to the requester closes or parks it", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertAgent(handle.db, { id: "job-manager", systemPrompt: "manager" });
  const workerId = await insertAgent(handle.db, { id: "job-worker", systemPrompt: "worker", parentAgentId: managerId });
  const d = deps();

  await deliverAgentMessage(d, { fromAgentId: managerId, toAgentId: workerId, content: "read the page" });
  let [job] = await jobsOf(workerId);
  assert.equal(job?.requesterId, managerId);
  assert.equal(job?.answerBy, null);

  await deliverAgentMessage(d, { fromAgentId: workerId, toAgentId: managerId, content: "which page?", status: "needs_input" });
  [job] = await jobsOf(workerId);
  assert.equal(job?.state, "needs_input");

  await deliverAgentMessage(d, { fromAgentId: managerId, toAgentId: workerId, content: "the syllabus" });
  [job] = await jobsOf(workerId);
  assert.equal(job?.state, "open", "the requester's answer reopens it");

  const done = await deliverAgentMessage(d, { fromAgentId: workerId, toAgentId: managerId, content: "3 items", status: "done" });
  [job] = await jobsOf(workerId);
  assert.equal(job?.state, "done");
  assert.equal(job?.closedSeq, done.seq);

  await deliverAgentMessage(d, { fromAgentId: managerId, toAgentId: workerId, content: "now the exams page" });
  assert.deepEqual((await jobsOf(workerId)).map((row) => row.state).sort(), ["done", "open"], "a new request after the result is a new job");
});

test("a reply to an ask joins the job the ask was made in and wakes that agent's work lane", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const eduId = await insertAgent(handle.db, { id: "education-specialist", systemPrompt: "edu" });
  const classId = await insertAgent(handle.db, { id: "cse-300-specialist", systemPrompt: "class", parentAgentId: eduId });
  const d = deps();

  await deliverUserMessage(d, eduId, "what is due tonight?");
  const [eduJob] = await jobsOf(eduId);
  await deliverAgentMessage(d, { fromAgentId: eduId, toAgentId: classId, content: "what is due tonight?", jobId: eduJob!.id });
  const [ask] = await handle.db.select().from(messages).where(eq(messages.toAgentId, classId));
  assert.equal(ask?.jobId, eduJob?.id, "the ask carries the sender's job");
  const [classJob] = await jobsOf(classId);
  assert.equal(classJob?.requesterId, eduId);

  d.woken.length = 0;
  await deliverAgentMessage(d, { fromAgentId: classId, toAgentId: eduId, content: "Module 8 quiz at 11:59 PM", status: "done" });
  assert.equal((await jobsOf(eduId)).length, 1, "the reply opened no new job");
  assert.deepEqual(
    d.woken.map((entry) => [entry.lane, entry.agentId, entry.origin?.jobId, entry.origin?.jobIsNew]),
    [["work", eduId, eduJob!.id, false]],
  );
  const [classDone] = await jobsOf(classId);
  assert.equal(classDone?.state, "done", "the status closed the class's own job");
});

test("a helper report joins the job its task was last steered in, even after another job opened", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "helper-agent", systemPrompt: "agent" });
  const otherId = await insertAgent(handle.db, { id: "helper-other", systemPrompt: "other" });
  const d = deps();

  await deliverUserMessage(d, agentId, "read D2L");
  const [first] = await jobsOf(agentId);
  await noteSteer(handle.db, "task/browser/3", agentId, first!.id, "Read the due dates on D2L");
  await deliverAgentMessage(d, { fromAgentId: otherId, toAgentId: agentId, content: "unrelated ask" });
  assert.equal((await jobsOf(agentId)).length, 2);
  assert.equal(await jobOfTask(handle.db, "task/browser/3"), first?.id);
  assert.equal(await jobOfTask(handle.db, "task/browser/9"), null, "a task never steered belongs to no job");

  await noteSteer(handle.db, "task/browser/3", agentId, null, "again, outside any job");
  assert.equal(await jobOfTask(handle.db, "task/browser/3"), null, "a later steer replaces the job");
});

test("the wake header gives the job's asks with their answers, what was told, and the last day's activity", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const eduId = await insertAgent(handle.db, { id: "education-specialist", systemPrompt: "edu" });
  const aId = await insertAgent(handle.db, { id: "cse-300-specialist", systemPrompt: "a", parentAgentId: eduId });
  const bId = await insertAgent(handle.db, { id: "cse-335-specialist", systemPrompt: "b", parentAgentId: eduId });
  const d = deps();

  const opening = await deliverUserMessage(d, eduId, "What is due tonight?");
  const [job] = await jobsOf(eduId);
  const toA = await deliverAgentMessage(d, { fromAgentId: eduId, toAgentId: aId, content: "due tonight?", jobId: job!.id });
  const toB = await deliverAgentMessage(d, { fromAgentId: eduId, toAgentId: bId, content: "due tonight?", jobId: job!.id });
  const answer = await deliverAgentMessage(d, { fromAgentId: aId, toAgentId: eduId, content: "Module 8 quiz" });

  const render = (jobIsNew: boolean) =>
    renderHeader({
      db: handle.db,
      agentId: eduId,
      reasons: ["message from Ankur"],
      jobId: job!.id,
      jobIsNew,
      now: new Date(),
      activityHours: 24,
      activityShare: 0.05,
      ceilingTokens: 96_000,
    });
  const header = await render(true);
  assert.match(header, new RegExp(`^\\[Wake\\] message from Ankur · job #${opening.seq} \\(new\\)`));
  assert.match(header, /\[Job #\d+\] opened by Ankur, [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2} [AP]M: "What is due tonight\?" · answer by /);
  assert.match(header, new RegExp(`asked: cse-300-specialist #${toA.seq} \\(answered #${answer.seq}\\), cse-335-specialist #${toB.seq} \\(no answer yet\\)`));
  assert.match(header, /helpers: none · stored: none · told Ankur: nothing yet/);
  assert.match(header, /\[Your recent activity, last 24 h\] none$/);

  await recordActivity(handle.db, { agentId: eduId, jobId: job!.id, kind: "site_read", subject: "d2l.msu.edu", digest: "task/browser/3 ok: nothing due" });
  await deliverAgentMessage(d, { fromAgentId: eduId, toAgentId: null, content: "Nothing is due tonight.", status: "done" });
  const later = await render(false);
  assert.match(later, /\(continues\)/);
  assert.match(later, /told Ankur: #\d+ "Nothing is due tonight\."/);
  assert.match(later, /\[Your recent activity, last 24 h\] site_read d2l\.msu\.edu .* \(task\/browser\/3 ok: nothing due\)/);
});

test("a wake with no job says so, and the ledger of a missing job is an error", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "no-job-agent", systemPrompt: "agent" });
  const header = await renderHeader({
    db: handle.db,
    agentId,
    reasons: ["lane failure"],
    jobId: null,
    jobIsNew: false,
    now: new Date(),
    activityHours: 24,
    activityShare: 0.05,
    ceilingTokens: 96_000,
  });
  assert.match(header, /^\[Wake\] lane failure · no job\n\[Your recent activity/);
  await assert.rejects(
    renderHeader({ db: handle.db, agentId, reasons: [], jobId: randomUUID(), jobIsNew: false, now: new Date(), activityHours: 24, activityShare: 0.05, ceilingTokens: 96_000 }),
    /does not exist/,
  );
});

test("hath's pickup is a message marked sent_by hath with no status, in the job it is about, and it does not change the job", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "pickup-agent", systemPrompt: "agent" });
  const d = deps();
  await deliverUserMessage(d, agentId, "plan my week");
  const [job] = await jobsOf(agentId);
  await handle.db.insert(agentLogs).values({ id: randomUUID(), agentId, lane: "work", event: "response", payload: {} });

  assert.equal(await sendPickups(d, new Date(Date.now() + 200_000), 180_000, null), 1);
  const [pickup] = await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId));
  assert.deepEqual([pickup?.content, pickup?.status, pickup?.sentBy, pickup?.jobId], ["Working on it.", null, "hath", job?.id]);
  assert.equal((await jobsOf(agentId))[0]?.state, "open");
  assert.equal(await sendPickups(d, new Date(Date.now() + 200_000), 180_000, null), 0, "one pickup per message");
});
