/**
 * The answer-by timer: Ankur's questions are answered within `runtime.answer_by_minutes` of his
 * message. When that time passes with the job still open, hath wakes the agent with what has
 * and has not come in. Only jobs Ankur opened have an answer-by time, and each is told once.
 */

import { and, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, jobs } from "../db/schema.js";
import type { NasClient } from "../nas/client.js";
import { localTime } from "./activity.js";
import { deliverAgentMessage, type DeliverDeps } from "./deliver.js";
import { jobLedger } from "./ledger.js";
import { pendingItems } from "./pending.js";

export type AnswerByDeps = { deliver: DeliverDeps; nas: NasClient };

/** answerByNotice is the notice text: the job, then what is in and what is not. */
export async function answerByNotice(db: Db, nas: NasClient, job: typeof jobs.$inferSelect): Promise<string> {
  const ledger = await jobLedger(db, job);
  const pending = await pendingItems(db, nas, job.id);
  const received = [
    ...ledger.asks.filter((ask) => ask.answered_seq !== null).map((ask) => `${ask.to} answered (#${ask.answered_seq})`),
    ...ledger.helpers.filter((task) => !pending.tasks.includes(task)).map((task) => `${task} finished`),
    ...ledger.stored.map((title) => `stored "${title}"`),
  ];
  const missing = [...pending.asks.map((to) => `${to} has not answered`), ...pending.tasks.map((task) => `${task} is still working`)];
  return [
    `[Answer time] Ankur's answer time for job #${ledger.job} (${localTime(job.answerBy!)}) has passed and he has no answer from you yet.`,
    `  in: ${received.length === 0 ? "nothing yet" : received.join(", ")}`,
    `  not in: ${missing.length === 0 ? "nothing" : missing.join(", ")}`,
  ].join("\n");
}

/**
 * checkAnswerBy tells each agent whose Ankur job is still open past its answer-by time, once,
 * as a message from hath that wakes it. Run from the scheduler's tick.
 */
export async function checkAnswerBy(deps: AnswerByDeps, now: Date): Promise<void> {
  const db = deps.deliver.db;
  const due = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.state, "open"), lte(jobs.answerBy, now), isNull(jobs.answerNoticedAt)));
  for (const job of due) {
    const [claimed] = await db
      .update(jobs)
      .set({ answerNoticedAt: now })
      .where(and(eq(jobs.id, job.id), isNull(jobs.answerNoticedAt)))
      .returning({ id: jobs.id });
    const [agent] = await db.select({ active: agents.active }).from(agents).where(eq(agents.id, job.agentId));
    if (claimed === undefined || agent?.active !== true) {
      continue;
    }
    await deliverAgentMessage(deps.deliver, {
      fromAgentId: job.agentId,
      toAgentId: job.agentId,
      content: await answerByNotice(db, deps.nas, job),
      notice: "answer_by",
      sentBy: "hath",
      jobId: job.id,
      wokenBy: "Ankur's answer time passed",
    });
  }
}
