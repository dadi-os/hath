/** `GET /attachments/:id` — an attachment's original file, for previews and downloads. */

import type { FastifyInstance } from "fastify";
import { getAttachment } from "../db/attachments.js";
import { MAX_ATTACHMENT_BYTES } from "../runtime/attachments.js";
import { attachmentIdParam, parse } from "./schemas.js";

export async function registerAttachments(app: FastifyInstance): Promise<void> {
  app.get("/attachments/:id", async (request, reply) => {
    const { id } = parse(attachmentIdParam, request.params);
    const row = await getAttachment(app.db, id);
    if (row.path === null) {
      throw new Error(`attachment ${id} has no file`);
    }
    const file = await app.nas.readFileBytes({ path: row.path, max_bytes: MAX_ATTACHMENT_BYTES });
    const body = Buffer.from(file.data, "base64");
    const type = row.mediaType.startsWith("text/") ? `${row.mediaType}; charset=utf-8` : row.mediaType;
    return reply
      .header("content-type", type)
      .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
      .send(body);
  });
}
