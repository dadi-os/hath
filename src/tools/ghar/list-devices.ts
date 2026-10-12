import { z } from "zod";
import { defineTool } from "../types.js";
import { gharToolCall } from "./call.js";

const capability = z.enum([
  "switchable",
  "dimmable",
  "colorable",
  "sensor",
  "lockable",
  "media",
  "thermostat",
]);

const input = z
  .object({
    room: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    capability: capability.optional(),
  })
  .strict();

/** Discover devices and their capabilities via Ghar `GET /devices`. */
export const listDevices = defineTool({
  name: "ghar_list_devices",
  description:
    "Find what devices exist in the house and what each one can do. Call this before ghar_control_device when you do not already know the device id and its capabilities from this turn — the capabilities listed here are exactly the ones ghar_control_device accepts. Prefer filtering by room, tag, or capability instead of listing everything and reasoning over the full set.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      room: { type: "string", description: "Room name filter" },
      tag: { type: "string", description: "Tag name filter" },
      capability: {
        type: "string",
        enum: [
          "switchable",
          "dimmable",
          "colorable",
          "sensor",
          "lockable",
          "media",
          "thermostat",
        ],
        description: "Only devices that expose this capability",
      },
    },
  },
  async handler(ctx, parsed) {
    const query = {
      ...(parsed.room !== undefined ? { room: parsed.room } : {}),
      ...(parsed.tag !== undefined ? { tag: parsed.tag } : {}),
      ...(parsed.capability !== undefined ? { capability: parsed.capability } : {}),
    };
    return gharToolCall(
      () => ctx.ghar.listDevices(query),
      (response) => ({
        devices: response.devices.map((device) => ({
          id: device.id,
          name: device.name,
          room: device.room,
          tags: device.tags,
          capabilities: device.capabilities,
          online: device.online,
          last_seen_at: device.last_seen_at,
          vendor_name: device.vendor_name,
          product_name: device.product_name,
          state: device.state,
        })),
      }),
    );
  },
});
