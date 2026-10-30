import { z } from "zod";
import { defineTool } from "../types.js";
import { gharToolCall } from "./call.js";

/** Hard cap so open-ended history questions stay within model context. */
const MAX_EVENTS = 50;

const input = z
  .object({
    device_id: z.union([z.string().uuid(), z.array(z.string().uuid()).min(1)]).optional(),
    room: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
    since: z.string().min(1).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    cause: z.enum(["agent", "user", "external"]).optional(),
    limit: z.number().int().positive().max(MAX_EVENTS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .strict();

/** Historical device events via Ghar `GET /events`. */
export const getDeviceEvents = defineTool({
  name: "ghar_get_device_events",
  description:
    `Read what happened in the house from the device event log. Filter by device, room, tag, attribute key, time range, and cause. cause distinguishes agent actions from someone flipping a physical switch (external) and from other user-attributed commands — that distinction is usually the point of the question. There is no live watcher: this is how you learn house history. Returns at most ${MAX_EVENTS} rows; pass since as the last event id you saw to page forward without duplicates.`,
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      device_id: {
        oneOf: [
          { type: "string", description: "Read the house's device event log: what changed, on which device, when, and the cause (an agent's command, someone at a physical switch, or another command made for a person). Filter by device, room, tag, attribute, time range and cause. Returns at most 50 events; pass since as the last event id you saw to page forward. ghar_get_state answers what is true now in one call." },
          { type: "array", items: { type: "string" }, minItems: 1 },
        ],
        description: "Device id or ids; omit for all devices",
      },
      room: { type: "string", description: "Room name scope" },
      tag: { type: "string", description: "Tag name scope" },
      key: { type: "string", description: "Attribute key, e.g. on or occupancy" },
      since: {
        type: "string",
        description: "Exclusive event id cursor, or ISO timestamp lower bound",
      },
      until: { type: "string", description: "ISO-8601 upper bound" },
      cause: {
        type: "string",
        enum: ["agent", "user", "external"],
        description: "Who/what caused the change",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_EVENTS,
        description: `Max rows (default ${MAX_EVENTS}, hard cap ${MAX_EVENTS})`,
      },
      order: { type: "string", enum: ["asc", "desc"] },
    },
  },
  async handler(ctx, parsed) {
    const query = {
      ...(parsed.device_id !== undefined ? { device_id: parsed.device_id } : {}),
      ...(parsed.room !== undefined ? { room: parsed.room } : {}),
      ...(parsed.tag !== undefined ? { tag: parsed.tag } : {}),
      ...(parsed.key !== undefined ? { key: parsed.key } : {}),
      ...(parsed.since !== undefined ? { since: parsed.since } : {}),
      ...(parsed.until !== undefined ? { until: parsed.until } : {}),
      ...(parsed.cause !== undefined ? { cause: parsed.cause } : {}),
      limit: parsed.limit ?? MAX_EVENTS,
      ...(parsed.order !== undefined ? { order: parsed.order } : {}),
    };
    return gharToolCall(
      () => ctx.ghar.listEvents(query),
      (response) => ({
        events: response.events.map((event) => ({
          id: event.id,
          device_id: event.device_id,
          attribute_key: event.attribute_key,
          old_value: event.old_value,
          new_value: event.new_value,
          cause: event.cause,
          cause_ref: event.cause_ref,
          created_at: event.created_at,
        })),
      }),
    );
  },
});
