/**
 * `POST /router` — Ankur speaks to the router, not to an agent. The router runs
 * its lane (see runtime/router.ts) until it yields and returns every message it
 * sent as him, in order. May be empty. `GET /router` lists the runs in flight.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { type AttachmentMeta, deleteUnboundAttachments, stageAttachments } from "../db/attachments.js";
import { attachmentStub, prepareUploads } from "../runtime/attachments.js";
import type { RouterRun } from "../types/domain.js";
import { parse, postRouterBody } from "./schemas.js";

/**
 * Register the router endpoints. Attachments are staged unbound and shown to the
 * router as stubs; it hands them on with forward_attachment, and whatever it did
 * not forward is deleted when the run ends. A run is in flight from the moment it
 * is accepted, so a device that connects mid-run reads it from `GET /router`. While
 * one is in flight, another `POST /router` is refused with `409 router_busy`; the
 * check and the registration share one synchronous step, so two requests cannot both pass.
 */
export async function registerRouter(app: FastifyInstance): Promise<void> {
  /** The ISO start time of each run in flight, by run id; a run leaves before its finish event goes out, so a read after that event never lists it. */
  const running = new Map<string, string>();

  app.get("/router", async () => ({
    running: [...running].map(([run_id, at]): RouterRun => ({ run_id, at })),
  }));

  app.post("/router", async (request, reply) => {
    const body = parse(postRouterBody, request.body);
    const active = running.entries().next().value;
    if (active !== undefined) {
      const [activeRunId, activeAt] = active;
      return reply.status(409).send({
        error: { type: "router_busy", message: "Dadi is busy with another request", run_id: activeRunId, at: activeAt },
      });
    }
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    running.set(runId, startedAt);
    let staged: AttachmentMeta[] = [];
    try {
      app.runtime.events.emit({ type: "router_started", run_id: runId, at: startedAt });
      const uploads = await prepareUploads({ dwar: app.dwar, files: app.runtime.files }, body.attachments ?? []);
      staged = await stageAttachments(app.db, null, uploads);
      const utterance = [body.content.trim(), ...staged.map(attachmentStub)]
        .filter((part) => part.length > 0)
        .join("\n\n");
      const messages = await app.runtime.route(utterance);
      running.delete(runId);
      app.runtime.events.emit({ type: "router_finished", run_id: runId, at: new Date().toISOString() });
      return reply.status(201).send({ messages });
    } catch (err) {
      running.delete(runId);
      const message = err instanceof Error ? err.message : String(err);
      app.runtime.events.emit({ type: "router_failed", run_id: runId, message, at: new Date().toISOString() });
      throw err;
    } finally {
      await deleteUnboundAttachments(
        app.db,
        staged.map((meta) => meta.id),
      );
    }
  });
}
