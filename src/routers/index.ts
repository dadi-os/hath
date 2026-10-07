/** Mount message, attachment, router, agent, schedule, tool, and SSE event routes. */

import type { FastifyInstance } from "fastify";
import { registerAgents } from "./agents.js";
import { registerAttachments } from "./attachments.js";
import { registerRouter } from "./router.js";
import { registerEvents } from "./events.js";
import { registerDevices } from "./devices.js";
import { registerMessages } from "./messages.js";
import { registerSchedules } from "./schedules.js";
import { registerTools } from "./tools.js";

export async function registerV1(app: FastifyInstance): Promise<void> {
  await registerRouter(app);
  await registerMessages(app);
  await registerAttachments(app);
  await registerAgents(app);
  await registerSchedules(app);
  await registerTools(app);
  await registerEvents(app);
  await registerDevices(app);
}
