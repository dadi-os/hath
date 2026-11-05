import { z } from "zod";
import { GET_DEVICE } from "../../types/domain.js";
import { defineTool } from "../types.js";
import { gharToolCall } from "./call.js";

const input = z
  .object({
    device_ids: z.array(z.string().uuid()).min(1).optional(),
  })
  .strict();

/**
 * Devices with their capabilities and current state, via Ghar `GET /devices` for all of them
 * or `GET /devices/:id` for the ones named. Each state value carries `changed_at`, so how
 * long something has held is answered in the same call.
 */
export const getDevice = defineTool({
  name: GET_DEVICE,
  description:
    "Read the house's devices: each one's id, name, tags, kind (light, plug, cover, thermostat, lock, robot_vacuum, washer, speaker, …), online flag, capabilities with their config, and current state, where every value carries changed_at, when it last changed. Tags are how the house is grouped (a device can have many, e.g. \"ankur's bed lights\"). Give device_ids for specific devices, or nothing for every device. Use changed_at for how long something has been that way (\"has the hall been empty for a while\", \"how long has that light been on\"). To change a device, use control_device.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      device_ids: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Only these devices, by id from an earlier get_device; omit for every device",
      },
    },
  },
  async handler(ctx, parsed) {
    return gharToolCall(
      async () =>
        parsed.device_ids === undefined
          ? (await ctx.ghar.listDevices()).devices
          : await Promise.all(parsed.device_ids.map((id) => ctx.ghar.getDevice(id))),
      (devices) => ({
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
          kind: device.kind,
          bridge_name: device.bridge_name,
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
