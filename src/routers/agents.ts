/** Agent list/detail/log routes. */

import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { listHumanMessages } from "../db/messages.js";
import { agentLogs, agents, agentTools, tools } from "../db/schema.js";
import type { AgentRow } from "../db/schema.js";
import { requireAgent } from "../runtime/tools.js";
import { toAgentRecord, toLogRecord } from "../serialize.js";
import type { AgentRecord } from "../types/domain.js";
import { agentLogsQuery, agentMessagesQuery, idParam, logsQuery, parse } from "./schemas.js";

/** The most rows a `wakes` read of an agent's logs returns, newest first. */
const WAKE_LOGS_MAX_ROWS = 3_000;

/**
 * agentWakeLogs is every log row of agent `id`'s newest `wakes` wakes, newest first,
 * with the rows outside any wake (boot recovery's reports, rows from before wake ids)
 * written since the oldest of them began. A wake is whole however many rows it wrote,
 * so the activity feed never shows one without the message that started it. Null
 * when the agent has no row with a wake id yet.
 */
async function agentWakeLogs(app: FastifyInstance, id: string, wakes: number) {
  const newest = await app.db
    .select({ wakeId: agentLogs.wakeId, startedAt: sql<string>`min(${agentLogs.createdAt})` })
    .from(agentLogs)
    .where(and(eq(agentLogs.agentId, id), sql`${agentLogs.wakeId} is not null`))
    .groupBy(agentLogs.wakeId)
    .orderBy(sql`max(${agentLogs.createdAt}) desc`)
    .limit(wakes);
  if (newest.length === 0) {
    return null;
  }
  const ids = newest.map((row) => row.wakeId!);
  const since = newest.reduce((oldest, row) => (row.startedAt < oldest ? row.startedAt : oldest), newest[0]!.startedAt);
  return app.db
    .select()
    .from(agentLogs)
    .where(
      and(
        eq(agentLogs.agentId, id),
        sql`(${agentLogs.wakeId} in (${sql.join(ids.map((wakeId) => sql`${wakeId}::uuid`), sql`, `)}) or (${agentLogs.wakeId} is null and ${agentLogs.createdAt} >= ${since}::timestamptz))`,
      ),
    )
    .orderBy(desc(agentLogs.createdAt))
    .limit(WAKE_LOGS_MAX_ROWS);
}

/** Attach ephemeral running locks and host sessions for API responses. */
function withLive(row: AgentRow, runtime: FastifyInstance["runtime"]): AgentRecord {
  return {
    ...toAgentRecord(row),
    running: {
      reasoning: runtime.locks.isHeld(row.id, "reasoning"),
      conversation: runtime.locks.isHeld(row.id, "conversation"),
    },
    sessions: runtime.sessions.forAgent(row.id),
  };
}

async function agentDetail(app: FastifyInstance, agentRow: AgentRow) {
  const childRows = await app.db
    .select()
    .from(agents)
    .where(eq(agents.parentAgentId, agentRow.id));
  const toolRows = await app.db
    .select({
      name: tools.name,
      description: tools.description,
      usage: agentTools.usage,
    })
    .from(agentTools)
    .innerJoin(tools, eq(agentTools.toolId, tools.id))
    .where(eq(agentTools.agentId, agentRow.id));
  return {
    ...withLive(agentRow, app.runtime),
    children: childRows.map((row) => withLive(row, app.runtime)),
    tools: toolRows.map((row) => ({
      name: row.name,
      description: row.description,
      usage: row.usage,
    })),
  };
}

/** Register agent list/detail/log routes. */
export async function registerAgents(app: FastifyInstance): Promise<void> {
  app.get("/agents", async () => {
    const rows = await app.db.select().from(agents);
    return {
      agents: rows.map((row) => withLive(row, app.runtime)),
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

  app.get("/agents/:id/logs", async (request) => {
    const { id } = parse(idParam, request.params);
    await requireAgent(app.db, id);
    const query = parse(agentLogsQuery, request.query);
    if (query.wakes !== undefined && query.event === undefined) {
      const rows = await agentWakeLogs(app, id, query.wakes);
      if (rows !== null) {
        return { logs: rows.map(toLogRecord) };
      }
    }
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
