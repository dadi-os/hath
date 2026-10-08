/** Drizzle table definitions for agents, logs, tools, grants, messages, and schedules. */

import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Postgres `bytea`, read and written as a Node Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const agents = pgTable(
  "agents",
  {
    /** Immutable kebab-case id; also the human-readable address (`browser-manager`). */
    id: text("id").primaryKey(),
    systemPrompt: text("system_prompt").notNull(),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("agent_logs_agent_id_created_at_idx").on(table.agentId, table.createdAt),
    check("agent_logs_lane_check", sql`${table.lane} IN ('reasoning', 'conversation', 'router')`),
    check(
      "agent_logs_event_check",
      sql`${table.event} IN ('response', 'tool_result', 'message')`,
    ),
  ],
);

export const tools = pgTable(
  "tools",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("tools_name_idx").on(table.name)],
);

/** Per-agent tool grant with a usage hint shown alongside the tool description. */
export const agentTools = pgTable(
  "agent_tools",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => tools.id),
    usage: text("usage").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.toolId] })],
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_seq_idx").on(table.seq),
    index("messages_to_agent_id_seq_idx").on(table.toAgentId, table.seq),
    index("messages_from_agent_id_seq_idx").on(table.fromAgentId, table.seq),
    index("messages_created_at_idx").on(table.createdAt),
  ],
);

/**
 * A file sent with a message. Unbound (`message_id` null) from upload or
 * create_attachment until a message carries it; a later forward copies the row,
 * so each message owns its attachments and deleting it deletes them.
 *
 * - Text files keep their UTF-8 text in `text_content` (paged by read_attachment);
 *   everything else keeps its bytes in `data`. Exactly one is set.
 * - `description` is the image.describe text for images, null otherwise.
 * - `created_by_agent_id` is null for Ankur's uploads; an agent's unbound
 *   attachments go when the agent does.
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
    textContent: text("text_content"),
    data: bytea("data"),
    description: text("description"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("attachments_message_id_position_idx").on(table.messageId, table.position),
    check(
      "attachments_payload_check",
      sql`(${table.textContent} IS NULL) <> (${table.data} IS NULL)`,
    ),
  ],
);

/**
 * Deferred dispatch_message that survives restart. Presence of the row is the
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
 * An agent's summary of the messages older than its transcript, one row per
 * agent once its history first passes `history_max_chars`. The transcript shows
 * only messages after `summarized_through_seq`; the summary stands in for the rest.
 */
export const agentHistories = pgTable("agent_histories", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  /** messages.seq of the newest message the summary covers. */
  summarizedThroughSeq: bigint("summarized_through_seq", { mode: "number" }).notNull(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export type AgentRow = typeof agents.$inferSelect;
export type AgentLogRow = typeof agentLogs.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type ToolRow = typeof tools.$inferSelect;
export type AgentToolRow = typeof agentTools.$inferSelect;
export type ScheduledMessageRow = typeof scheduledMessages.$inferSelect;
