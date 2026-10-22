import { z } from "zod";
import { defineTool } from "../types.js";
import { nasToolCall } from "./call.js";

const input = z
  .object({
    name: z.string().min(1),
  })
  .strict();

/** Restart a named module via Nas POST /modules/{name}/restart. */
export const restartModule = defineTool({
  name: "nas_restart_module",
  description:
    "Restart a host module by name (dwar, yaad, hath, ghar, chaavi, nas, caddy, headscale, loki, alloy, tailscale). Restarting hath ends this process — do not expect a reply after that call.",
  input,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Module name" },
    },
    required: ["name"],
  },
  async handler(ctx, parsed) {
    return nasToolCall(
      () => ctx.nas.restartModule(parsed.name),
      (body) => body,
    );
  },
});
