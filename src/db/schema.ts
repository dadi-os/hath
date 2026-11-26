/** Drizzle table definitions for agents, logs, messages, and schedules. */

import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ActivityKind, JobState, MessageStatus, MessageKind, WakeReasonKind } from "../types/domain.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const agents = pgTable(
  "agents",
  {
    /** Immutable kebab-case id; also the human-readable address (`finance-specialist`). */
    id: text("id").primaryKey(),
    systemPrompt: text("system_prompt").notNull(),
    /** The agent's entry in the agent directory, in its template (see runtime/directory.ts); null until set. */
    description: text("description"),
    /** Deleting a parent deletes its whole subtree. */
    parentAgentId: text("parent_agent_id").references((): AnyPgColumn => agents.id, {
      onDelete: "cascade",
    }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("agents_parent_agent_id_idx").on(table.parentAgentId),
    check(
      "agents_id_kebab_check",
      sql`${table.id} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'`,
    ),
  ],
);

export const agentLogs = pgTable(
  "agent_logs",
  {
    id: uuid("id").primaryKey(),
    /** Null for the router, which shares the user's null identity. */
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /**
     * The wake this row belongs to (see runtime/wake.ts): its turns and tool results.
     * Null for the router, rows from before wake ids,
     * and runtime reports written outside any wake (boot recovery).
     */
    wakeId: uuid("wake_id"),
    /** The job the wake was on when the row was written (see jobs); null for the router and for rows from before jobs were stamped. */
    jobId: uuid("job_id"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("agent_logs_agent_id_created_at_idx").on(table.agentId, table.createdAt),
    index("agent_logs_wake_id_idx").on(table.wakeId),
    index("agent_logs_job_id_idx").on(table.jobId),
    index("agent_logs_tool_use_id_idx")
      .on(sql`(${table.payload}->>'tool_use_id')`)
      .where(sql`${table.event} = 'tool_result'`),
    check(
      "agent_logs_event_check",
      sql`${table.event} IN ('response', 'tool_result')`,
    ),
  ],
);

/**
 * Durable chat transcript. Survives restart. Null party = human.
 * `seq` is stable across process restarts (identity column).
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    fromAgentId: text("from_agent_id").references(() => agents.id, { onDelete: "cascade" }),
    toAgentId: text("to_agent_id").references(() => agents.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    /** What an agent's message to whoever gave it the job says about that job; null on every other message. */
    status: text("status").$type<MessageStatus>(),
    /**
     * message, or notice: hath's own word that an agent's work stopped (a failed run, a job
     * left unfinished, a restart), between the agent it is about and its requester. A notice
     * is never chat: no one wrote it, it opens no job and makes no one a requester.
     * utterance: what Ankur said to the router (from and to null), which is no one's message.
     */
    kind: text("kind").$type<MessageKind>().notNull().default("message"),
    /** The recipient wake this message opened or joined (see `wakes`); null when it woke no one. */
    wakeId: uuid("wake_id"),
    /**
     * The job the message belongs to (see runtime/job-of.ts): stamped on every delivered inbound
     * message and on every message an agent sends; null on rows from before jobs were stamped
     * and on messages that belong to no job.
     */
    jobId: uuid("job_id"),
    /** `hath` on a message hath sent for the agent (a pickup, an answer-by notice); null on every other. */
    sentBy: text("sent_by").$type<"hath">(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_seq_idx").on(table.seq),
    index("messages_job_id_idx").on(table.jobId),
    check("messages_sent_by_check", sql`${table.sentBy} IS NULL OR ${table.sentBy} = 'hath'`),
    check("messages_kind_check", sql`${table.kind} IN ('message', 'notice', 'utterance')`),
    index("messages_wake_id_idx").on(table.wakeId),
    index("messages_to_agent_id_seq_idx").on(table.toAgentId, table.seq),
    index("messages_from_agent_id_seq_idx").on(table.fromAgentId, table.seq),
    index("messages_created_at_idx").on(table.createdAt),
    check(
      "messages_status_check",
      sql`${table.status} IS NULL OR ${table.status} IN ('needs_input', 'blocked', 'done')`,
    ),
  ],
);

/**
 * One stretch of an agent's work (see runtime/wake.ts): written when the wake is created,
 * `ended_at` set when the last run releases, `error` set when a run died or boot
 * recovery cut it. `reason_ref` is the sender agent id for `message`, the schedule id for
 * `schedule`, else null. `opened_by_message_id` is a soft reference to `messages.id`.
 */
export const wakes = pgTable(
  "wakes",
  {
    id: uuid("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    reasonKind: text("reason_kind").$type<WakeReasonKind>().notNull(),
    reasonRef: text("reason_ref"),
    openedByMessageId: uuid("opened_by_message_id"),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    endedAt: timestamptz("ended_at"),
    error: text("error"),
  },
  (table) => [
    index("wakes_agent_id_started_at_idx").on(table.agentId, table.startedAt.desc(), table.id),
    check(
      "wakes_reason_kind_check",
      sql`${table.reasonKind} IN ('message', 'schedule', 'recovery', 'steer', 'manual')`,
    ),
  ],
);

/**
 * How far Ankur has read each agent's thread: messages to him at or below
 * `read_seq` are read. One row per agent, moved only forward, so every device
 * agrees on what is unread.
 */
export const threadReads = pgTable("thread_reads", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  readSeq: bigint("read_seq", { mode: "number" }).notNull(),
  readAt: timestamptz("read_at").notNull().defaultNow(),
});

/**
 * A job: the work an agent does for one requester, or for itself. The requester's first
 * message opens a job and its later ones join it, until the agent reports done or blocked,
 * hath closes it when the agent's wake ends, or Ankur stops it (see runtime/job-of.ts).
 *
 * - `requester_id`: null is Ankur; the agent's own id is no one: a routine run, or a reminder
 *   that outlived its job.
 * - `state`: `open`, `needs_input` while the agent's question waits on the requester, then
 *   `done`, `blocked`, `stopped`, or `noop` for a message that needed no work.
 * - `routine_id`: the routine whose firing opened the job; null on every other.
 * - `answer_by`: when Ankur's answer is due; null on every job that is not his.
 * - `question_seq`: the agent's open `needs_input` message, cleared by the requester's next message.
 * - `opened_seq` is also the job's number in the wake header.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    requesterId: text("requester_id").references(() => agents.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    state: text("state").$type<JobState>().notNull(),
    openedSeq: bigint("opened_seq", { mode: "number" }).notNull(),
    questionSeq: bigint("question_seq", { mode: "number" }),
    closedSeq: bigint("closed_seq", { mode: "number" }),
    routineId: uuid("routine_id"),
    answerBy: timestamptz("answer_by"),
    /** When hath told the agent that its answer time passed with the job still open; null until it does (see runtime/answer-by.ts). */
    answerNoticedAt: timestamptz("answer_noticed_at"),
    stoppedAt: timestamptz("stopped_at"),
    stoppedBy: text("stopped_by"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("jobs_open_line_idx")
      .on(table.requesterId, table.agentId)
      .where(sql`${table.state} IN ('open', 'needs_input') AND ${table.requesterId} IS DISTINCT FROM ${table.agentId}`),
    index("jobs_agent_id_idx").on(table.agentId),
    index("jobs_requester_id_idx").on(table.requesterId),
    check(
      "jobs_state_check",
      sql`${table.state} IN ('open', 'needs_input', 'done', 'blocked', 'noop', 'stopped')`,
    ),
    check(
      "jobs_stopped_check",
      sql`(${table.state} = 'stopped') = (${table.stoppedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * An agent's own standing duty (see runtime/routines.ts). `at_local` is the wall-clock time
 * of day in the box's zone and `days` the weekdays it runs on (null is every day);
 * `next_run_at` is the ticker's cursor. A routine has an owner and no recipient: nobody sends
 * it. `set_up_by` names the agent that set up a routine for its owner before routines were
 * owned (the data migration); the first firing says so, then clears it.
 */
export const routines = pgTable(
  "routines",
  {
    id: uuid("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    procedure: text("procedure").notNull(),
    atLocal: text("at_local").notNull(),
    days: text("days").array(),
    nextRunAt: timestamptz("next_run_at").notNull(),
    lastRunAt: timestamptz("last_run_at"),
    lastJobId: uuid("last_job_id"),
    active: boolean("active").notNull(),
    setUpBy: text("set_up_by").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("routines_agent_title_idx").on(table.agentId, table.title),
    index("routines_next_run_at_idx").on(table.nextRunAt),
    check("routines_at_local_check", sql`${table.atLocal} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
    check(
      "routines_days_check",
      sql`${table.days} IS NULL OR (cardinality(${table.days}) >= 1 AND ${table.days} <@ ARRAY['mon','tue','wed','thu','fri','sat','sun']::text[])`,
    ),
  ],
);

/**
 * A later step of a job: a one-shot that fires into its job at `run_at`. The row is deleted
 * when it fires. `job_id` is null only on a row the data migration made from a one-shot
 * scheduled message, which had no job: its firing opens one, with `author_id` as requester.
 */
export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => agents.id, { onDelete: "cascade" }),
    note: text("note").notNull(),
    runAt: timestamptz("run_at").notNull(),
  },
  (table) => [
    index("reminders_run_at_idx").on(table.runAt),
    index("reminders_job_id_idx").on(table.jobId),
    check("reminders_job_or_author_check", sql`${table.jobId} IS NOT NULL OR ${table.authorId} IS NOT NULL`),
  ],
);

/**
 * What an agent did, written by hath from tool results and never by the agent (see
 * runtime/activity.ts). `subject` is what it was done to (hosts, node titles, a recipient, a
 * routine's title) and `digest` the short account of the outcome.
 */
export const agentActivity = pgTable(
  "agent_activity",
  {
    id: uuid("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    jobId: uuid("job_id"),
    at: timestamptz("at").notNull().defaultNow(),
    kind: text("kind").$type<ActivityKind>().notNull(),
    subject: text("subject").notNull(),
    digest: text("digest").notNull(),
  },
  (table) => [
    index("agent_activity_agent_id_at_idx").on(table.agentId, table.at),
    index("agent_activity_job_id_idx").on(table.jobId),
    check(
      "agent_activity_kind_check",
      sql`${table.kind} IN ('site_read', 'store', 'recall_digest', 'send', 'routine', 'reminder', 'stop')`,
    ),
  ],
);

/**
 * The job each helper task was last steered in, so the task's report joins that job (see
 * runtime/job-of.ts). One row per task; a steer replaces it. `message` is the steer's text.
 */
export const helperSteers = pgTable("helper_steers", {
  /** The task's address, such as `task/browser/3`. */
  task: text("task").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  jobId: uuid("job_id"),
  message: text("message").notNull(),
  steeredAt: timestamptz("steered_at").notNull().defaultNow(),
});

/**
 * The newest report of each helper task already delivered to its agent, by the report's
 * own time (`at`). Nas numbers reports from 1 on every start, so the number cannot say
 * whether a report was delivered; its time can, and every task's reports are in time order.
 */
export const deliveredReports = pgTable("delivered_reports", {
  /** The task's address, such as `task/browser/3`. */
  task: text("task").primaryKey(),
  deliveredAt: timestamptz("delivered_at").notNull(),
});

/**
 * An async tool call still running. Its result arrives as a message when it ends; a row
 * left behind by a restart is reported lost at boot.
 */
export const pendingAsync = pgTable(
  "pending_async",
  {
    /** The call's id, which the agent was given as `pending`. */
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
  },
  (table) => [index("pending_async_agent_id_idx").on(table.agentId)],
);

/**
 * What an agent is waiting on: task addresses and agent ids. One row per agent.
 * It is dropped when the agent next runs, and a due one wakes the agent with facts.
 */
export const watches = pgTable("watches", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  targets: text("targets").array().notNull(),
  since: timestamptz("since").notNull().defaultNow(),
  dueAt: timestamptz("due_at").notNull(),
  /** The job the wait was made in: a timeout joins it (see runtime/job-of.ts). */
  jobId: uuid("job_id"),
});

export type AgentRow = typeof agents.$inferSelect;
export type AgentLogRow = typeof agentLogs.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type RoutineRow = typeof routines.$inferSelect;
export type ReminderRow = typeof reminders.$inferSelect;
export type ActivityRow = typeof agentActivity.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type WatchRow = typeof watches.$inferSelect;
export type WakeRow = typeof wakes.$inferSelect;
