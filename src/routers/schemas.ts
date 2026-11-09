/** Request body / param zod schemas and parse helpers for HTTP routes. */

import { z, type ZodError } from "zod";
import { agentIdSchema } from "../agent-id.js";
import { HathError } from "../errors.js";

/** Parse with zod; map failures to `422 invalid_request`. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new HathError(422, "invalid_request", formatZod(parsed.error));
  }
  return parsed.data;
}

/** Flatten zod issues into a single semicolon-joined message. */
export function formatZod(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const loc = issue.path.join(".");
      return loc ? `${loc}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

const messageAttachment = z
  .object({
    media_type: z.string().min(1),
    data: z.string().min(1),
    filename: z.string().min(1).optional(),
  })
  .strict();

export const postRouterBody = z
  .object({
    /** May be empty when attachments are present; patched server-side. */
    content: z.string(),
    attachments: z.array(messageAttachment).max(8).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.content.trim().length === 0 && (body.attachments?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "content or attachments required",
        path: ["content"],
      });
    }
  });

export const postMessageBody = z
  .object({
    to_agent_id: agentIdSchema,
    /** May be empty when attachments are present; patched server-side. */
    content: z.string(),
    attachments: z.array(messageAttachment).max(8).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.content.trim().length === 0 && (body.attachments?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "content or attachments required",
        path: ["content"],
      });
    }
  });

export const idParam = z.object({ id: agentIdSchema }).strict();

/** Body of `POST /agents/:id/read`: the last message Ankur has read in that thread. */
export const threadReadBody = z.object({ seq: z.number().int().positive() }).strict();

/** Path params for one scheduled message, addressed by its uuid. */
export const scheduleIdParam = z.object({ id: z.string().uuid() }).strict();

/** Path params for one attachment, addressed by its uuid. */
export const attachmentIdParam = z.object({ id: z.string().uuid() }).strict();

/** A hand edit to a schedule: any of its time, repeat (null makes it one-shot), or message. */
export const patchScheduleBody = z
  .object({
    run_at: z.string().datetime({ offset: true }).optional(),
    interval_minutes: z.number().int().min(1).nullable().optional(),
    content: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "nothing to change" });

/** An agent's or every agent's logs: the newest `limit` rows, optionally of one event. */
export const logsQuery = z
  .object({
    event: z.enum(["response", "tool_result"]).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

/** Path params for one of an agent's wakes. */
export const wakeParam = z.object({ id: agentIdSchema, wake_id: z.string().uuid() }).strict();

/** Path params for one of an agent's log rows. */
export const logParam = z.object({ id: agentIdSchema, log_id: z.string().uuid() }).strict();

/** The `task/<kind>/<id>` address of a helper task, as `GET /agents` lists it. */
export const sessionParam = z
  .object({ id: agentIdSchema, task_id: z.string().regex(/^task\/(browser|terminal)\/[^/]+$/, "expected task/<browser|terminal>/<id>") })
  .strict();

/** Query of `GET /agents/:id/sessions/:task_id/log`: entries after `after_seq` (default 0), at most `limit` (default 200, max 1000). */
export const sessionLogQuery = z
  .object({
    after_seq: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().positive().max(1000).default(200),
  })
  .strict();

/** Query of `GET /agents/:id/wakes`: a page size and the keyset cursor `(before_started_at, before_id)`, given together. */
export const wakesQuery = z
  .object({
    limit: z.coerce.number().int().positive().max(100).default(20),
    before_started_at: z.string().datetime({ offset: true }).optional(),
    before_id: z.string().uuid().optional(),
  })
  .strict()
  .refine((query) => (query.before_started_at === undefined) === (query.before_id === undefined), {
    message: "before_started_at and before_id go together",
    path: ["before_id"],
  });

export const agentMessagesQuery = z
  .object({
    since_seq: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().max(500).default(200),
  })
  .strict();
