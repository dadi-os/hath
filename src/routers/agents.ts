/** Agent list/detail/log routes. */

import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { listHumanMessages, markThreadRead } from "../db/messages.js";
import { listWakes, loadWakeEntries, loadWakeRecords, requireWake } from "../db/wakes.js";
import { agentLogs, agents, watches } from "../db/schema.js";
import type { AgentRow, WatchRow } from "../db/schema.js";
import type { HelperTask } from "../nas/client.js";
import { requireAgent } from "../runtime/tools.js";
import { HathError } from "../errors.js";
import { toAgentRecord, toLogRecord } from "../serialize.js";
import { toAgentSession } from "../runtime/sessions.js";
import type { AgentRecord } from "../types/domain.js";
import {
  agentMessagesQuery,
  idParam,
  logParam,
  logsQuery,
  parse,
  sessionParam,
  threadReadBody,
  wakeParam,
  wakesQuery,
} from "./schemas.js";

/** What a response shows beyond the stored rows: Nas's tasks and every agent's watch. */
type Live = { tasks: HelperTask[]; watches: Map<string, WatchRow> };

async function loadLive(app: FastifyInstance): Promise<Live> {
  const [tasks, watchRows] = await Promise.all([app.runtime.sessions.snapshot(), app.db.select().from(watches)]);
  return { tasks, watches: new Map(watchRows.map((row) => [row.agentId, row])) };
}

/**
 * Attach ephemeral running locks, what each lane waits on, the status block while a lane
 * runs or the work lane waits (null otherwise), and the agent's Nas tasks for API responses.
 */
async function withLive(row: AgentRow, runtime: FastifyInstance["runtime"], live: Live): Promise<AgentRecord> {
  const watch = live.watches.get(row.id);
  const work = runtime.locks.isHeld(row.id, "work");
  const process = runtime.locks.isHeld(row.id, "process");
  return {
    ...toAgentRecord(row),
    running: {
      work,
      process,
      waiting_on:
        watch === undefined
          ? null
          : { targets: watch.targets, since: watch.since.toISOString(), wakes_by: watch.dueAt.toISOString() },
      status: work || process || watch !== undefined ? await runtime.statusOf(row.id) : null,
    },
    sessions: runtime.sessions.forAgent(live.tasks, row.id),
  };
}

async function agentDetail(app: FastifyInstance, agentRow: AgentRow) {
  const live = await loadLive(app);
  const childRows = await app.db
    .select()
    .from(agents)
    .where(eq(agents.parentAgentId, agentRow.id));
  return {
    ...(await withLive(agentRow, app.runtime, live)),
    children: await Promise.all(childRows.map((row) => withLive(row, app.runtime, live))),
  };
}

/** Register agent list/detail/log routes. */
export async function registerAgents(app: FastifyInstance): Promise<void> {
  app.get("/agents", async () => {
    const rows = await app.db.select().from(agents);
    const live = await loadLive(app);
    return {
      agents: await Promise.all(rows.map((row) => withLive(row, app.runtime, live))),
    };
  });

  app.get("/agents/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const agentRow = await requireAgent(app.db, id);
    return agentDetail(app, agentRow);
  });

  app.get("/agents/:id/messages", async (request) => {
    const { id } = parse(idParam, request.params);
    await requireAgent(app.db, id);
    const query = parse(agentMessagesQuery, request.query);
    const messages = await listHumanMessages(app.db, id, {
      ...(query.since_seq !== undefined ? { sinceSeq: query.since_seq } : {}),
      limit: query.limit,
    });
    return { messages };
  });

  app.post("/agents/:id/read", async (request) => {
    const { id } = parse(idParam, request.params);
    await requireAgent(app.db, id);
    const { seq } = parse(threadReadBody, request.body);
    const mark = await markThreadRead(app.db, id, seq);
    app.runtime.events.emit({
      type: "thread_read",
      agent_id: id,
      read_seq: mark.read_seq,
      unread: mark.unread,
      at: new Date().toISOString(),
    });
    return { agent_id: id, ...mark };
  });

  app.get("/agents/:id/logs", async (request) => {
    const { id } = parse(idParam, request.params);
    await requireAgent(app.db, id);
    const query = parse(logsQuery, request.query);
    const limit = query.limit ?? 50;
    const rows = await app.db
      .select()
      .from(agentLogs)
      .where(
        query.event
          ? and(eq(agentLogs.agentId, id), eq(agentLogs.event, query.event))
          : eq(agentLogs.agentId, id),
      )
      .orderBy(desc(agentLogs.createdAt))
      .limit(limit);
    return { logs: rows.map(toLogRecord) };
  });

  app.get("/agents/:id/logs/:log_id", async (request) => {
    const { id, log_id } = parse(logParam, request.params);
    await requireAgent(app.db, id);
    const [row] = await app.db
      .select()
      .from(agentLogs)
      .where(and(eq(agentLogs.id, log_id), eq(agentLogs.agentId, id)));
    if (!row) {
      throw new HathError(404, "log_not_found", `log ${log_id} not found for agent ${id}`);
    }
    return { log: toLogRecord(row) };
  });

  app.get("/agents/:id/wakes", async (request) => {
    const { id } = parse(idParam, request.params);
    await requireAgent(app.db, id);
    const query = parse(wakesQuery, request.query);
    const rows = await listWakes(app.db, id, {
      limit: query.limit + 1,
      ...(query.before_started_at !== undefined && query.before_id !== undefined
        ? { before: { startedAt: new Date(query.before_started_at), id: query.before_id } }
        : {}),
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      wakes: await loadWakeRecords(app.db, id, page),
      next_before:
        rows.length > query.limit && last !== undefined
          ? { started_at: last.startedAt.toISOString(), id: last.id }
          : null,
    };
  });

  app.get("/agents/:id/wakes/:wake_id", async (request) => {
    const { id, wake_id } = parse(wakeParam, request.params);
    await requireAgent(app.db, id);
    const wake = await requireWake(app.db, id, wake_id);
    const [record] = await loadWakeRecords(app.db, id, [wake]);
    return { wake: record, entries: await loadWakeEntries(app.db, wake) };
  });

  app.post("/agents/:id/sessions/:task_id/halt", async (request) => {
    const { id, task_id } = parse(sessionParam, request.params);
    await requireAgent(app.db, id);
    const [, kind, taskId] = task_id.split("/") as [string, "browser" | "terminal", string];
    const owned = (await app.runtime.sessions.snapshot()).some(
      (task) => task.task === task_id && (task.owner === id || task.steered_by === id),
    );
    if (!owned) {
      throw new HathError(404, "task_not_found", `agent ${id} has no task ${task_id}`);
    }
    const halted = await app.nas.haltTask(kind, taskId).catch((err: unknown) => {
      if (err instanceof HathError && err.statusCode === 404) {
        throw new HathError(404, "task_not_found", err.message);
      }
      if (err instanceof HathError && err.statusCode === 409) {
        throw new HathError(409, "task_conflict", err.message);
      }
      throw err;
    });
    app.runtime.events.emit({ type: "sessions_changed", at: new Date().toISOString() });
    return { task: toAgentSession(halted) };
  });

  app.get("/logs", async (request) => {
    const query = parse(logsQuery, request.query);
    const limit = query.limit ?? 50;
    const rows = await app.db
      .select()
      .from(agentLogs)
      .where(query.event ? eq(agentLogs.event, query.event) : undefined)
      .orderBy(desc(agentLogs.createdAt))
      .limit(limit);
    return { logs: rows.map(toLogRecord) };
  });
}
