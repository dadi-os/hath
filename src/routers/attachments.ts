/** `GET /attachments/:id` — an attachment's original file, for previews and downloads. */

import type { FastifyInstance } from "fastify";
import { getAttachment } from "../db/attachments.js";
import { attachmentIdParam, parse } from "./schemas.js";

export async function registerAttachments(app: FastifyInstance): Promise<void> {
  app.get("/attachments/:id", async (request, reply) => {
    const { id } = parse(attachmentIdParam, request.params);
    const row = await getAttachment(app.db, id);
    const body = row.textContent !== null ? Buffer.from(row.textContent, "utf8") : row.data;
    if (body === null) {
      throw new Error(`attachment ${id} has neither text nor data`);
    }
    const type = row.textContent !== null ? `${row.mediaType}; charset=utf-8` : row.mediaType;
    return reply
      .header("content-type", type)
      .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
      .send(body);
  });
}
