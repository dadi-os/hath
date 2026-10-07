/**
 * `POST /router` — Ankur speaks to the router, not to an agent. The router runs
 * its lane (see runtime/router.ts) until it yields and returns every message it
 * sent as him, in order. May be empty.
 */

import type { FastifyInstance } from "fastify";
import { deleteUnboundAttachments, stageAttachments } from "../db/attachments.js";
import { attachmentStub, prepareUploads } from "../runtime/attachments.js";
import { parse, postRouterBody } from "./schemas.js";

/**
 * Register the router endpoint. Attachments are staged unbound and shown to the
 * router as stubs; it hands them on with forward_attachment, and whatever it did
 * not forward is deleted when the run ends.
 */
export async function registerRouter(app: FastifyInstance): Promise<void> {
  app.post("/router", async (request, reply) => {
    const body = parse(postRouterBody, request.body);
    const uploads = await prepareUploads(app.dwar, body.attachments ?? []);
    const staged = await stageAttachments(app.db, null, uploads);
    const utterance = [body.content.trim(), ...staged.map(attachmentStub)]
      .filter((part) => part.length > 0)
      .join("\n\n");
    app.runtime.events.emit({ type: "router_started", at: new Date().toISOString() });
    try {
      const messages = await app.runtime.route(utterance);
      app.runtime.events.emit({ type: "router_finished", at: new Date().toISOString() });
      return reply.status(201).send({ messages });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.runtime.events.emit({ type: "router_failed", message, at: new Date().toISOString() });
      throw err;
    } finally {
      await deleteUnboundAttachments(
        app.db,
        staged.map((meta) => meta.id),
      );
    }
  });
}
