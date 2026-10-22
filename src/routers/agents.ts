/** Agent list/detail/log routes. */

import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { listHumanMessages, markThreadRead } from "../db/messages.js";
import { agentLogs, agents, agentTools, tools } from "../db/schema.js";
import type { AgentRow } from "../db/schema.js";
import { requireAgent } from "../runtime/tools.js";
import { toAgentRecord, toLogRecord } from "../serialize.js";
import type { AgentRecord } from "../types/domain.js";
import { agentLogsQuery, agentMessagesQuery, idParam, logsQuery, parse, threadReadBody } from "./schemas.js";

/** The most rows a `wakes` read of an agent's logs returns, newest first. */
const WAKE_LOGS_MAX_ROWS = 3_000;

/** How many rows from before wake ids a `wakes` read adds when the agent has too few stamped wakes. */
const UNSTAMPED_ROWS = 200;

/** How far back past UNSTAMPED_ROWS a read looks for the message that opened the oldest unstamped wake. */
const OPENING_LOOKBACK_ROWS = 400;

/**
 * agentWakeLogs is every log row of agent `id`'s newest `wakes` wakes, newest first,
 * with the rows outside any wake (boot recovery's reports) written since the oldest of
 * them began. A wake is whole however many rows it wrote, so the activity feed never
 * shows one without the message that started it. When the agent has fewer stamped
 * wakes than asked for (its history is older than wake ids), its newest rows from
 * before them follow, reaching back to the received message that opened the oldest of
 * those, so the feed's guess at that wake starts where it really started.
 */
async function agentWakeLogs(app: FastifyInstance, id: string, wakes: number) {
  const newest = await app.db
    .select({ wakeId: agentLogs.wakeId, startedAt: sql<string>`min(${agentLogs.createdAt})` })
    .from(agentLogs)
    .where(and(eq(agentLogs.agentId, id), sql`${agentLogs.wakeId} is not null`))
    .groupBy(agentLogs.wakeId)
    .orderBy(sql`max(${agentLogs.createdAt}) desc`)
    .limit(wakes);
  const stamped =
    newest.length === 0
      ? []
      : await app.db
          .select()
          .from(agentLogs)
          .where(
            and(
              eq(agentLogs.agentId, id),
              sql`(${agentLogs.wakeId} in (${sql.join(
                newest.map((row) => sql`${row.wakeId!}::uuid`),
                sql`, `,
              )}) or (${agentLogs.wakeId} is null and ${agentLogs.createdAt} >= ${newest.reduce(
                (oldest, row) => (row.startedAt < oldest ? row.startedAt : oldest),
                newest[0]!.startedAt,
              )}::timestamptz))`,
            ),
          )
          .orderBy(desc(agentLogs.createdAt))
          .limit(WAKE_LOGS_MAX_ROWS);
  if (newest.length >= wakes) {
    return stamped;
  }
  // Boundaries compare in SQL against a row's own created_at, by id: a JS Date keeps only
  // milliseconds, and rows written within the same millisecond would fall between.
  const seen = new Set(stamped.map((row) => row.id));
  const unstampedUpTo = async (boundaryId: string | undefined, limit: number) =>
    (
      await app.db
        .select()
        .from(agentLogs)
        .where(
          and(
            eq(agentLogs.agentId, id),
            sql`${agentLogs.wakeId} is null`,
            ...(boundaryId !== undefined
              ? [sql`${agentLogs.createdAt} <= (select created_at from agent_logs where id = ${boundaryId}::uuid)`]
              : []),
          ),
        )
        .orderBy(desc(agentLogs.createdAt), desc(agentLogs.id))
        .limit(limit + seen.size)
    )
      .filter((row) => !seen.has(row.id))
      .slice(0, limit);
  const unstamped = await unstampedUpTo(stamped.at(-1)?.id, UNSTAMPED_ROWS);
  for (const row of unstamped) {
    seen.add(row.id);
  }
  const oldest = unstamped.at(-1);
  if (oldest !== undefined && !(oldest.event === "message" && oldest.payload.direction === "receive")) {
    const earlier = await unstampedUpTo(oldest.id, OPENING_LOOKBACK_ROWS);
    const opening = earlier.findIndex((row) => row.event === "message" && row.payload.direction === "receive");
    if (opening !== -1) {
      unstamped.push(...earlier.slice(0, opening + 1));
    }
  }
  return [...stamped, ...unstamped];
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
    const query = parse(agentLogsQuery, request.query);
    if (query.wakes !== undefined && query.event === undefined) {
      const rows = await agentWakeLogs(app, id, query.wakes);
      return { logs: rows.map(toLogRecord) };
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
