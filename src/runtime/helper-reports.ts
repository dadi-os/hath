/**
 * Helper reports: what a browser or terminal helper in Nas hands back (done, needs_input,
 * failed) reaches the agent whose steer it answers, as a message that wakes its work lane
 * (see rewake.ts), with the files it names as attachments.
 *
 * Nas publishes each report once on its event stream and keeps the newest of each task as
 * `last_report`; the stream has no replay. So hath reconciles from `GET /tasks` after every
 * connect, boot included, and delivers a report only if it is newer than the last one
 * delivered for its task (table `delivered_reports`). Reports are compared by the time they
 * carry, not their number, which Nas restarts from 1. Delivery is at least once: a crash
 * between the message and its mark delivers that report again on the next reconcile.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, deliveredReports } from "../db/schema.js";
import type { HelperReport, NasClient } from "../nas/client.js";
import { attachHostFile, type HostFileDeps } from "./attachments.js";
import type { DeliverDeps } from "./deliver.js";
import { rewakeWork } from "./rewake.js";
import { takeWatch } from "./watches.js";

type ReportLog = {
  error: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type HelperReportsDeps = {
  nas: NasClient;
  deliver: DeliverDeps;
  /** What turns the files a report names into attachments. */
  files: Pick<HostFileDeps, "dwar" | "files">;
  log: ReportLog;
};

/** How long the stream waits before reconnecting, doubling to a limit. */
const RECONNECT_START_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** HelperReports delivers Nas's helper reports to their agents. */
export class HelperReports {
  private abort: AbortController | undefined;
  /** Reports are handled one at a time, in the order they arrive. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: HelperReportsDeps) {}

  /** start follows Nas's event stream until stop, reconciling on every connect. */
  start(): void {
    if (this.abort !== undefined) {
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    void this.follow(abort.signal);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
  }

  /** reconcile delivers the newest report of every task that has not been delivered. */
  reconcile(): Promise<void> {
    return this.enqueue(async () => {
      const reports = (await this.deps.nas.listTasks())
        .flatMap((task) => (task.last_report ? [task.last_report] : []))
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      for (const report of reports) {
        await this.deliverOnce(report);
      }
    });
  }

  /** handle delivers one report from the stream unless it was already delivered. */
  handle(report: HelperReport): Promise<void> {
    return this.enqueue(() => this.deliverOnce(report));
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async follow(signal: AbortSignal): Promise<void> {
    let delay = RECONNECT_START_MS;
    while (!signal.aborted) {
      try {
        const stream = await this.deps.nas.openReports(signal);
        await this.reconcile();
        delay = RECONNECT_START_MS;
        for await (const event of stream) {
          if (event.type === "helper_report") {
            await this.handle(event.report);
          } else {
            this.deps.deliver.events.emit({ type: "sessions_changed", at: new Date().toISOString() });
          }
        }
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        this.deps.log.error({ code: "helper_reports_failed", err }, "helper report stream failed; reconnecting");
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }

  private async deliverOnce(report: HelperReport): Promise<void> {
    const db = this.deps.deliver.db;
    const at = new Date(report.at);
    const [mark] = await db.select().from(deliveredReports).where(eq(deliveredReports.task, report.task));
    if (mark !== undefined && mark.deliveredAt.getTime() >= at.getTime()) {
      return;
    }
    const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, report.agent_id));
    if (agent === undefined) {
      this.deps.log.error(
        { code: "helper_report_orphaned", task: report.task, agent_id: report.agent_id },
        "helper report for an agent that does not exist; dropped",
      );
    } else {
      await this.deliver(db, report);
    }
    await db
      .insert(deliveredReports)
      .values({ task: report.task, deliveredAt: at })
      .onConflictDoUpdate({ target: deliveredReports.task, set: { deliveredAt: at } });
  }

  private async deliver(db: Db, report: HelperReport): Promise<void> {
    const attachmentIds: string[] = [];
    const notes: string[] = [];
    for (const path of report.files) {
      try {
        const meta = await attachHostFile({ db, nas: this.deps.nas, ...this.deps.files }, report.agent_id, path);
        attachmentIds.push(meta.id);
      } catch (err) {
        notes.push(`${path} could not be attached: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await rewakeWork(this.deps.deliver, report.agent_id, {
      content: [`${HEADLINES[report.state]} (${report.task}):`, report.text, ...notes].join("\n"),
      notice: "helper",
      wokenBy: `helper result from ${report.task}`,
      attachmentIds,
    });
    await takeWatch(db, report.agent_id, report.task);
    this.deps.deliver.events.emit({ type: "sessions_changed", at: new Date().toISOString() });
  }
}

/** How a message opens, by what the helper reported. */
const HEADLINES: Record<HelperReport["state"], string> = {
  done: "Helper finished",
  needs_input: "Helper needs something from you",
  failed: "Helper failed",
};
