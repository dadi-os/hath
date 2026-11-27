/**
 * `POST /messages` — deliver a user message. A file goes in its content as a `box://` link.
 * `GET /threads` — human↔agent summaries. */

import type { FastifyInstance } from "fastify";
import { listThreads } from "../db/messages.js";
import { deliverUserMessage } from "../runtime/deliver.js";
import { requireActiveAgent } from "../runtime/tools.js";
import { postMessageBody, parse } from "./schemas.js";

export async function registerMessages(app: FastifyInstance): Promise<void> {
  app.get("/threads", async () => {
    const threads = await listThreads(app.db);
    return { threads };
  });

  app.post("/messages", async (request, reply) => {
    const body = parse(postMessageBody, request.body);
    await requireActiveAgent(app.db, body.to_agent_id);
    const row = await deliverUserMessage(app.runtime.deliver, body.to_agent_id, body.content);
    return reply.status(201).send({
      to_agent_id: row.toAgentId,
      content: row.content,
      seq: row.seq,
      created_at: row.createdAt.toISOString(),
    });
  });
}
