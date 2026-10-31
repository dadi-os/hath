import type { ToolDefinition } from "./types.js";
import { spawnAgent } from "./hath/spawn-agent.js";
import { getAgent } from "./hath/get-agent.js";
import { scheduleMessage } from "./hath/schedule-message.js";
import { listSchedules } from "./hath/list-schedules.js";
import { cancelSchedule } from "./hath/cancel-schedule.js";
import { getLogs as hathGetLogs } from "./hath/get-logs.js";
import { webFetch, webSearch } from "./web/web.js";
import { getDevice } from "./ghar/get-device.js";
import { controlDevice } from "./ghar/control-device.js";
import { listBrowsers, listTerminals, steerBrowser, steerTerminal } from "./helper/tasks.js";
import { editFile, findFiles, readFile, writeFile } from "./files/files.js";

/**
 * Every tool defined by a zod schema and a handler, in the order agents see them. Which
 * lane may call which is declared in runtime/lanes.ts, together with the lane tools
 * (send_message, queue_message, steer_work, yield, memory, list_agents, wait, manage_agent,
 * modify_agent_prompt) that have no definition here.
 */
const definitions = [
  spawnAgent,
  getDevice,
  controlDevice,
  getAgent,
  hathGetLogs,
  webSearch,
  webFetch,
  scheduleMessage,
  listSchedules,
  cancelSchedule,
  steerBrowser,
  steerTerminal,
  listBrowsers,
  listTerminals,
  readFile,
  findFiles,
  writeFile,
  editFile,
] as unknown as ToolDefinition[];

const byName = new Map<string, ToolDefinition>();
for (const definition of definitions) {
  if (byName.has(definition.name)) {
    throw new Error(`duplicate tool name in registry: ${definition.name}`);
  }
  byName.set(definition.name, definition);
}

/** Every tool definition. */
export function allTools(): ToolDefinition[] {
  return definitions;
}

/** The tool with this name, if any. */
export function findTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}
