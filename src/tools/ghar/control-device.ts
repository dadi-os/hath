import { z } from "zod";
import { GHAR_CAPABILITIES } from "../../ghar/client.js";
import { defineTool } from "../types.js";
import { gharToolCall } from "./call.js";

const input = z
  .object({
    device_id: z.string().uuid(),
    capability: z.enum(GHAR_CAPABILITIES),
    command: z.string().min(1),
    params: z.record(z.unknown()).optional(),
  })
  .strict();

/** Issue a capability command via Ghar, attributed to the calling agent. */
export const controlDevice = defineTool({
  name: "ghar_control_device",
  description: [
    "Change a device: pass its id, one of its capabilities from ghar_list_devices, a command, and that command's params.",
    "Commands: on_off on|off|toggle. level move_to {level 0–100} (brightness, or volume on speakers and TVs). color temperature {mireds} | hue_saturation {hue, saturation 0–254}.",
    "cover open|close|stop|go_to_lift {percent_open}|go_to_tilt {percent}. fan set_mode {mode off|low|medium|high|on|auto}|set_percent {percent}.",
    "thermostat set_mode {mode off|auto|cool|heat|fan_only|dry|…}|set_setpoint {heat_c, cool_c in °C, either or both}. temperature_control set {celsius} or {level} per its config.",
    "alarm self_test. rvc pause|go_home|set_clean_mode {mode}|select_areas {areas}. appliance pause|stop. mode change_to {mode}; mode and area ids come from the capability's config.",
    "media play|pause|stop|next|previous|select_input {index}|send_key {key}|launch_app {application_id, catalog_vendor_id}. camera set_privacy {enabled}.",
    "lock, valve, sensor, button, power_source and energy are read-only through this tool; read them with ghar_get_state.",
    "If the device lacks the capability or command you named, that is your mistake — pick one it lists. command_rejected means the device refused; device_unreachable means it did not answer. Both are facts about the world, not bad arguments.",
  ].join(" "),
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      device_id: { type: "string", description: "Target device id from ghar_list_devices" },
      capability: { type: "string", enum: [...GHAR_CAPABILITIES] },
      command: { type: "string", description: "Command name for that capability, e.g. on, move_to, set_setpoint" },
      params: {
        type: "object",
        description: "The command's params, e.g. {\"level\":40}, {\"heat_c\":21.5}, {\"percent_open\":60}; omit when it takes none",
      },
    },
    required: ["device_id", "capability", "command"],
  },
  async handler(ctx, parsed) {
    return gharToolCall(
      () =>
        ctx.ghar.command(parsed.device_id, {
          capability: parsed.capability,
          command: parsed.command,
          ...(parsed.params !== undefined ? { params: parsed.params } : {}),
          cause: "agent",
          cause_ref: ctx.callerId ?? ctx.callerKind,
        }),
      (response) => response,
    );
  },
});
