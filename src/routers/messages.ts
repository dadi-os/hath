/** `POST /messages` — deliver a user message; `GET /threads` — human↔agent summaries. */

import type { FastifyInstance } from "fastify";
import { toAttachmentSummary } from "../db/attachments.js";
import { listThreads } from "../db/messages.js";
import { prepareUploads } from "../runtime/attachments.js";
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
    const uploads = await prepareUploads(app.dwar, body.attachments ?? []);
    const row = await deliverUserMessage(
      {
        db: app.db,
        transcript: app.runtime.transcript,
        events: app.runtime.events,
        enqueueConversation: app.runtime.enqueueConversation,
      },
      body.to_agent_id,
      body.content.trim(),
      { uploads, forward: [] },
    );
    return reply.status(201).send({
      to_agent_id: row.toAgentId,
      content: row.content,
      attachments: row.attachments.map(toAttachmentSummary),
      seq: row.seq,
      created_at: row.createdAt.toISOString(),
    });
  });
}
