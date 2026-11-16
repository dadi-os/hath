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
import { jobOfTask, noteSteer, openRunJob } from "../src/runtime/job-of.js";
import { settleWakeJobs } from "../src/runtime/jobs.js";
import { Wake } from "../src/runtime/wake.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import type { WakeOrigin } from "../src/types/domain.js";
import { insertAgent, mockNas, openTestDb, resetRuntime, roomyWakeLimits, silentLog, testConfig } from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

type Woken = { agentId: string; origin: WakeOrigin | undefined };

/** Delivery deps that run no agent and record who would have been woken. */
function deps(): DeliverDeps & { woken: Woken[] } {
  const woken: Woken[] = [];
  return {
    db: handle.db,
    transcript: new TranscriptStore(),
    events: new EventBus(silentLog),
    answerByMinutes: 5,
    woken,
    enqueue: (agentId, _reason, origin) => {
      woken.push({ agentId, origin });
      return randomUUID();
    },
    preempt: () => {},
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

test("a reply to an ask joins the job the ask was made in and wakes that agent", async () => {
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
    d.woken.map((entry) => [entry.agentId, entry.origin?.jobId, entry.origin?.jobIsNew]),
    [[eduId, eduJob!.id, false]],
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
  assert.match(header, /\n\[Now\] [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2} [AP]M\n/);
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
    reasons: ["run failure"],
    jobId: null,
    jobIsNew: false,
    now: new Date(),
    activityHours: 24,
    activityShare: 0.05,
    ceilingTokens: 96_000,
  });
  assert.match(header, /^\[Wake\] run failure · no job\n\[Now\] [^\n]+\n\[Your recent activity/);
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
  await handle.db.insert(agentLogs).values({ id: randomUUID(), agentId, jobId: job!.id, event: "response", payload: {} });

  assert.equal(await sendPickups(d, new Date(Date.now() + 200_000), 180_000, async () => true), 1);
  const [pickup] = await handle.db.select().from(messages).where(eq(messages.fromAgentId, agentId));
  assert.deepEqual([pickup?.content, pickup?.status, pickup?.sentBy, pickup?.jobId], ["Working on it.", null, "hath", job?.id]);
  assert.equal((await jobsOf(agentId))[0]?.state, "open");
  assert.equal(await sendPickups(d, new Date(Date.now() + 200_000), 180_000, async () => true), 0, "one pickup per job");
});

/** Backdates every message of job `jobId`, in seq order, to the given ages in seconds before `now`. */
async function ageMessages(jobId: string, now: Date, agesS: number[]): Promise<void> {
  const rows = await handle.db.select({ id: messages.id }).from(messages).where(eq(messages.jobId, jobId)).orderBy(messages.seq);
  assert.equal(rows.length, agesS.length);
  for (const [i, row] of rows.entries()) {
    await handle.db.update(messages).set({ createdAt: new Date(now.getTime() - agesS[i]! * 1000) }).where(eq(messages.id, row.id));
  }
}

test("the pickup counts from his newest message in the job, within both age bounds, and from the agent's last word to him since", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "pickup-join-agent", systemPrompt: "agent" });
  const d = deps();
  const now = new Date();
  const afterMs = 180_000;

  await deliverUserMessage(d, agentId, "is the coffee on?");
  await deliverUserMessage(d, agentId, "and when does it start?");
  const [job] = await jobsOf(agentId);
  assert.equal((await jobsOf(agentId)).length, 1, "his second message joined the first's job");
  await handle.db.insert(agentLogs).values({ id: randomUUID(), agentId, jobId: job!.id, event: "response", payload: {} });

  await ageMessages(job!.id, now, [600, 60]);
  assert.equal(await sendPickups(d, now, afterMs, async () => true), 0, "the opening is old but the joined message is not");

  await ageMessages(job!.id, now, [1200, 1000]);
  assert.equal(await sendPickups(d, now, afterMs, async () => true), 0, "the newest message is past the horizon");

  await ageMessages(job!.id, now, [1200, 200]);
  assert.equal(await sendPickups(d, now, afterMs, async () => true), 1, "the newest message is due");
  assert.equal(await sendPickups(d, now, afterMs, async () => true), 0, "the pickup is a word to him after it");
});

test("a word to Ankur before his newest message does not stop the pickup for it; one after does", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "pickup-since-agent", systemPrompt: "agent" });
  const d = deps();
  const now = new Date();

  await deliverUserMessage(d, agentId, "first thing");
  const [job] = await jobsOf(agentId);
  await handle.db.insert(messages).values({ id: randomUUID(), fromAgentId: agentId, toAgentId: null, content: "On it.", jobId: job!.id });
  await deliverUserMessage(d, agentId, "second thing");
  await handle.db.insert(agentLogs).values({ id: randomUUID(), agentId, jobId: job!.id, event: "response", payload: {} });
  await ageMessages(job!.id, now, [400, 300, 200]);
  assert.equal(await sendPickups(d, now, 180_000, async () => true), 1, "the earlier word answered the earlier message");

  await resetRuntime(handle.sql, handle.db, config);
  const other = await insertAgent(handle.db, { id: "pickup-since-other", systemPrompt: "agent" });
  await deliverUserMessage(d, other, "only thing");
  const [otherJob] = await jobsOf(other);
  await handle.db.insert(messages).values({ id: randomUUID(), fromAgentId: other, toAgentId: null, content: "On it.", jobId: otherJob!.id });
  await handle.db.insert(agentLogs).values({ id: randomUUID(), agentId: other, jobId: otherJob!.id, event: "response", payload: {} });
  await ageMessages(otherJob!.id, now, [400, 300]);
  assert.equal(await sendPickups(d, now, 180_000, async () => true), 0, "a word after his message answered it");
});

test("a message to the requester with no status is the answer and closes the job; one to anyone else does not", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const managerId = await insertAgent(handle.db, { id: "answer-manager", systemPrompt: "manager" });
  const workerId = await insertAgent(handle.db, { id: "answer-worker", systemPrompt: "worker", parentAgentId: managerId });
  const peerId = await insertAgent(handle.db, { id: "answer-peer", systemPrompt: "peer" });
  const d = deps();

  await deliverAgentMessage(d, { fromAgentId: managerId, toAgentId: workerId, content: "read the page" });
  await deliverAgentMessage(d, { fromAgentId: workerId, toAgentId: peerId, content: "do you know the page?" });
  assert.equal((await jobsOf(workerId))[0]?.state, "open", "an ask to a third agent leaves the job open");

  const answer = await deliverAgentMessage(d, { fromAgentId: workerId, toAgentId: managerId, content: "3 items" });
  const [job] = await jobsOf(workerId);
  assert.equal(job?.state, "done");
  assert.equal(job?.closedSeq, answer.seq);
});

test("a no-status reply to Ankur closes his job, and a later message from him opens the next", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "reply-agent", systemPrompt: "agent" });
  const d = deps();

  await deliverUserMessage(d, agentId, "is the coffee still on?");
  await deliverAgentMessage(d, { fromAgentId: agentId, toAgentId: null, content: "Yes, 3 PM." });
  assert.deepEqual((await jobsOf(agentId)).map((row) => row.state), ["done"]);

  await deliverUserMessage(d, agentId, "and tomorrow?");
  assert.deepEqual((await jobsOf(agentId)).map((row) => row.state).sort(), ["done", "open"]);
});

/** A wake whose steps are the calls named in `calls`, one turn each. */
function wakeThatCalled(calls: string[], jobId: string | null = null): Wake {
  const wake = new Wake(roomyWakeLimits);
  wake.jobId = jobId;
  calls.forEach((name, i) => {
    wake.push({ message: { role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name, input: {} }] } });
  });
  return wake;
}

test("a wake that only yielded closes an agent's job as noop; Ankur's job, and one worked on, stay open", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const idleId = await insertAgent(handle.db, { id: "idle-agent", systemPrompt: "agent" });
  const busyId = await insertAgent(handle.db, { id: "busy-agent", systemPrompt: "agent" });
  const askerId = await insertAgent(handle.db, { id: "asker-agent", systemPrompt: "agent" });
  const d = deps();
  await deliverAgentMessage(d, { fromAgentId: askerId, toAgentId: idleId, content: "ok thanks" });
  await deliverAgentMessage(d, { fromAgentId: askerId, toAgentId: busyId, content: "ok thanks" });
  const ankursId = await insertAgent(handle.db, { id: "ankurs-agent", systemPrompt: "agent" });
  await deliverUserMessage(d, ankursId, "what is due tonight?");
  const nas = mockNas({});

  await settleWakeJobs(handle.db, nas, d.transcript.transcriptFor(idleId), idleId, wakeThatCalled(["yield"]));
  await settleWakeJobs(handle.db, nas, d.transcript.transcriptFor(busyId), busyId, wakeThatCalled(["read_file", "yield"]));
  await settleWakeJobs(handle.db, nas, d.transcript.transcriptFor(ankursId), ankursId, wakeThatCalled(["yield"]));

  assert.deepEqual((await jobsOf(idleId)).map((row) => row.state), ["noop"]);
  assert.deepEqual((await jobsOf(busyId)).map((row) => row.state), ["open"]);
  assert.deepEqual((await jobsOf(ankursId)).map((row) => row.state), ["open"], "the answer-by timer is the backstop for an answer he is owed");
});

test("a routine's job closes when its run ends with nothing pending, and stays open while a helper it steered works", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const doneId = await insertAgent(handle.db, { id: "routine-done", systemPrompt: "agent" });
  const waitingId = await insertAgent(handle.db, { id: "routine-waiting", systemPrompt: "agent" });
  const nas = mockNas({});
  await nas.startTask("browser", { agent_id: waitingId, message: "go" });
  const d = deps();
  const doneRow = await deliverAgentMessage(d, { fromAgentId: doneId, toAgentId: doneId, content: "Your routine fired.", notice: "routine" });
  const waitingRow = await deliverAgentMessage(d, { fromAgentId: waitingId, toAgentId: waitingId, content: "Your routine fired.", notice: "routine" });
  const doneJob = await openRunJob(handle.db, { agentId: doneId, seq: doneRow.seq, routineId: null, requesterId: doneId });
  const waitingJob = await openRunJob(handle.db, { agentId: waitingId, seq: waitingRow.seq, routineId: null, requesterId: waitingId });
  await noteSteer(handle.db, "task/browser/1", waitingId, waitingJob.id, "go");

  await settleWakeJobs(handle.db, nas, [], doneId, wakeThatCalled(["read_file", "yield"], doneJob.id));
  await settleWakeJobs(handle.db, nas, [], waitingId, wakeThatCalled(["steer_browser", "yield"], waitingJob.id));

  assert.equal((await jobsOf(doneId))[0]?.state, "done");
  assert.equal((await jobsOf(waitingId))[0]?.state, "open");
});
