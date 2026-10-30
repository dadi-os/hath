import { z } from "zod";
import { GHAR_CAPABILITIES, GHAR_KINDS } from "../../ghar/client.js";
import { defineTool } from "../types.js";
import { gharToolCall } from "./call.js";

const capability = z.enum(GHAR_CAPABILITIES);
const kind = z.enum(GHAR_KINDS);

const input = z
  .object({
    room: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    capability: capability.optional(),
    kind: kind.optional(),
  })
  .strict();

/** Discover devices and their capabilities via Ghar `GET /devices`. */
export const listDevices = defineTool({
  name: "ghar_list_devices",
  description:
    "List the devices in the house: each one's id, name, room, tags, kind (light, plug, cover, thermostat, lock, robot_vacuum, washer, speaker, …) and capabilities, each capability with its config (color modes, setpoint support, modes, areas, inputs, sensor units). The capabilities listed are exactly what ghar_control_device accepts. Filter by room, tag, capability or kind rather than listing everything.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      room: { type: "string", description: "Room name filter" },
      tag: { type: "string", description: "Tag name filter" },
      capability: {
        type: "string",
        enum: [...GHAR_CAPABILITIES],
        description: "Only devices that expose this capability",
      },
      kind: {
        type: "string",
        enum: [...GHAR_KINDS],
        description: "Only devices of this kind",
      },
    },
  },
  async handler(ctx, parsed) {
    const query = {
      ...(parsed.room !== undefined ? { room: parsed.room } : {}),
      ...(parsed.tag !== undefined ? { tag: parsed.tag } : {}),
      ...(parsed.capability !== undefined ? { capability: parsed.capability } : {}),
      ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
    };
    return gharToolCall(
      () => ctx.ghar.listDevices(query),
      (response) => ({
        devices: response.devices.map((device) => ({
          id: device.id,
          name: device.name,
          kind: device.kind,
          bridge_name: device.bridge_name,
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
