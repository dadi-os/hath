/** Append durable agent log rows (response, tool_result, message). */

import { randomUUID } from "node:crypto";
import type { Db } from "./client.js";
import { agentLogs } from "./schema.js";
import type { LogEvent } from "../types/domain.js";

/** Appends one event to an agent's (or the router's) durable log. */
export async function writeAgentLog(
  db: Db,
  args: {
    /** Null for the router. */
    agentId: string | null;
    event: LogEvent;
    payload: Record<string, unknown>;
    /** The wake the row belongs to; null (or left out) outside any wake. */
    wakeId?: string | null | undefined;
    /** The job the wake was on; null (or left out) when it was on none. */
    jobId?: string | null | undefined;
  },
): Promise<void> {
  await db.insert(agentLogs).values({
    id: randomUUID(),
    agentId: args.agentId,
    event: args.event,
    payload: args.payload,
    wakeId: args.wakeId ?? null,
    jobId: args.jobId ?? null,
  });
}
