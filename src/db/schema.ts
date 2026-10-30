/** Drizzle table definitions for agents, logs, messages, and schedules. */

import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { HandoffState, JobState, MessageStatus, MessageKind } from "../types/domain.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Postgres `bytea`, read and written as a Node Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

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
    lane: text("lane").notNull(),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /**
     * The wake this row belongs to (see runtime/wake.ts): its lanes' turns and tool results,
     * the messages it received and sent. Null for the router, rows from before wake ids,
     * and runtime reports written outside any wake (boot recovery).
     */
    wakeId: uuid("wake_id"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("agent_logs_agent_id_created_at_idx").on(table.agentId, table.createdAt),
    index("agent_logs_wake_id_idx").on(table.wakeId),
    index("agent_logs_tool_use_id_idx")
      .on(sql`(${table.payload}->>'tool_use_id')`)
      .where(sql`${table.event} = 'tool_result'`),
    check("agent_logs_lane_check", sql`${table.lane} IN ('work', 'process', 'router')`),
    check(
      "agent_logs_event_check",
      sql`${table.event} IN ('response', 'tool_result', 'message')`,
    ),
  ],
);

/**
 * Durable chat / lane transcript. Survives restart. Null party = human.
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
     * message, or notice: hath's own word that an agent's work stopped (a failed lane, a job
     * left unfinished, a restart), between the agent it is about and its requester. A notice
     * is never chat: no one wrote it, it opens no job and makes no one a requester.
     */
    kind: text("kind").$type<MessageKind>().notNull().default("message"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_seq_idx").on(table.seq),
    check("messages_kind_check", sql`${table.kind} IN ('message', 'notice')`),
    index("messages_to_agent_id_seq_idx").on(table.toAgentId, table.seq),
    index("messages_from_agent_id_seq_idx").on(table.fromAgentId, table.seq),
    index("messages_created_at_idx").on(table.createdAt),
    check(
      "messages_status_check",
      sql`${table.status} IS NULL OR ${table.status} IN ('running', 'needs_input', 'blocked', 'done')`,
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
 * The work open on one line: a requester (null for Ankur) that messaged the agent
 * before the agent ever messaged it. The requester's first message opens a job and
 * its later ones join it, until the agent reports done or blocked, or hath closes it
 * when the agent's wake ends (see jobs.ts).
 *
 * - `state`: `open`, `needs_input` while the agent's question waits on the requester,
 *   then `done`, `blocked`, or `noop` for a message that needed no work.
 * - `progress_seq`: the agent's one `running` message on the job.
 * - `question_seq`: the agent's open `needs_input` message, cleared by the requester's next message.
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
    progressSeq: bigint("progress_seq", { mode: "number" }),
    questionSeq: bigint("question_seq", { mode: "number" }),
    closedSeq: bigint("closed_seq", { mode: "number" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("jobs_open_line_idx")
      .on(table.requesterId, table.agentId)
      .where(sql`${table.state} IN ('open', 'needs_input')`),
    index("jobs_agent_id_idx").on(table.agentId),
    index("jobs_requester_id_idx").on(table.requesterId),
    check(
      "jobs_state_check",
      sql`${table.state} IN ('open', 'needs_input', 'done', 'blocked', 'noop')`,
    ),
  ],
);

/**
 * A file sent with a message. Unbound (`message_id` null) from upload or
 * attachHostFile until a message carries it; a later forward copies the row,
 * so each message owns its attachments and deleting it deletes them. The file is on the
 * box at `path` (see runtime/files.ts), never rewritten, so a copied row shares it.
 *
 * - `description` is the image.describe text for images, null otherwise.
 * - `created_by_agent_id` is null for Ankur's uploads; an agent's unbound
 *   attachments go when the agent does.
 * - `text_content` and `data` are the bytes older rows kept here. Boot moves them to files
 *   and clears them (see runtime/attachments.ts moveLegacyAttachments); once none is
 *   left a migration drops both columns and makes `path` required.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey(),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    createdByAgentId: text("created_by_agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    position: integer("position").notNull(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    path: text("path"),
    textContent: text("text_content"),
    data: bytea("data"),
    description: text("description"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("attachments_message_id_position_idx").on(table.messageId, table.position),
  ],
);

/**
 * Deferred send that survives restart. Presence of the row is the
 * state — no status/active/last_fired columns.
 *
 * - `run_at` is the next fire time (ticker cursor), never a "created for" time.
 * - `interval_minutes` null = one-shot (delete on fire); non-null = recurring
 *   (`run_at` advances by the interval after each fire).
 * - `from_agent_id` is always set; scheduled messages are never from the human.
 */
export const scheduledMessages = pgTable(
  "scheduled_messages",
  {
    id: uuid("id").primaryKey(),
    fromAgentId: text("from_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toAgentId: text("to_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    runAt: timestamptz("run_at").notNull(),
    intervalMinutes: integer("interval_minutes"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("scheduled_messages_run_at_idx").on(table.runAt),
    check(
      "scheduled_messages_interval_minutes_check",
      sql`${table.intervalMinutes} IS NULL OR ${table.intervalMinutes} >= 1`,
    ),
    check(
      "scheduled_messages_from_to_check",
      sql`${table.fromAgentId} <> ${table.toAgentId}`,
    ),
  ],
);

/**
 * What an agent's work lane has asked its process lane to say (the work lane's `message`
 * tool). The process lane sends it, alone or merged with others to the same recipient;
 * each row is `sent` once a message to its recipient went out, and `failed` when the lane
 * failed first. `expects_reply` holds from the send until the recipient's next message,
 * which wakes the work lane directly. The SQL table keeps its pre-overhaul name
 * "handoffs", so its rows (kind and declined state included) stay as they were.
 */
export const outbox = pgTable(
  "handoffs",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Null is Ankur. */
    toAgentId: text("to_agent_id").references(() => agents.id, { onDelete: "cascade" }),
    /** Set only on rows from before the lane overhaul: result, blocker, question, progress, note or request. */
    kind: text("kind"),
    content: text("content").notNull(),
    attachmentIds: uuid("attachment_ids").array().notNull().default(sql`'{}'::uuid[]`),
    state: text("state").$type<HandoffState>().notNull().default("pending"),
    /** The message a sent row became. */
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Why a row was declined (before the overhaul) or failed. */
    reason: text("reason"),
    expectsReply: boolean("expects_reply").notNull().default(false),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    resolvedAt: timestamptz("resolved_at"),
  },
  (table) => [
    index("handoffs_agent_state_idx").on(table.agentId, table.state),
    check("handoffs_kind_check", sql`${table.kind} IN ('result', 'blocker', 'question', 'progress', 'note', 'request')`),
    check("handoffs_state_check", sql`${table.state} IN ('pending', 'sent', 'declined', 'failed')`),
  ],
);

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
 * What an agent's work lane is waiting on: task addresses and agent ids. One row per agent.
 * It is dropped when the lane next runs, and a due one wakes the lane with facts.
 */
export const watches = pgTable("watches", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  targets: text("targets").array().notNull(),
  since: timestamptz("since").notNull().defaultNow(),
  dueAt: timestamptz("due_at").notNull(),
});

export type AgentRow = typeof agents.$inferSelect;
export type AgentLogRow = typeof agentLogs.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type ScheduledMessageRow = typeof scheduledMessages.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type WatchRow = typeof watches.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
