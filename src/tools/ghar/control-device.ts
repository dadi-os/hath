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
    device_id: z.string().uuid(),
    capability,
    params: z.record(z.unknown()),
  })
  .strict();

/** Issue a capability command via Ghar, attributed to the calling agent. */
export const controlDevice = defineTool({
  name: "ghar_control_device",
  description:
    "Change a device. Pass the device id, a capability from ghar_list_devices, and that capability's params. For dimmable, level is 0–100 (not Matter's raw 0–254). switchable params.state is on, off, or toggle. colorable takes color_temp or hue+saturation. If the device lacks the capability you named, that is your mistake — pick a supported capability. If the device does not respond, that is a fact about the world, not a bad argument.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      device_id: { type: "string", description: "Target device id from list_devices" },
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
      },
      params: {
        type: "object",
        description:
          "Capability parameters, e.g. {\"state\":\"on\"}, {\"level\":40}, {\"color_temp\":300}",
      },
    },
    required: ["device_id", "capability", "params"],
  },
  async handler(ctx, parsed) {
    return gharToolCall(
      () =>
        ctx.ghar.command(parsed.device_id, {
          capability: parsed.capability,
          params: parsed.params,
          cause: "agent",
          cause_ref: ctx.callerId ?? ctx.callerKind,
        }),
      (response) => response,
    );
  },
});
