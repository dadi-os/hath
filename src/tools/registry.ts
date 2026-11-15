import type { ToolDefinition } from "./types.js";
import { spawnAgent } from "./hath/spawn-agent.js";
import { getAgent } from "./hath/get-agent.js";
import { setRoutine } from "./hath/set-routine.js";
import { endRoutine } from "./hath/end-routine.js";
import { listRoutines } from "./hath/list-routines.js";
import { remindMe } from "./hath/remind-me.js";
import { myActivity } from "./hath/my-activity.js";
import { getLogs as hathGetLogs } from "./hath/get-logs.js";
import { getMessages } from "./hath/get-messages.js";
import { webFetch, webSearch } from "./web/web.js";
import { getDevice } from "./ghar/get-device.js";
import { controlDevice } from "./ghar/control-device.js";
import { listBrowsers, listTerminals, steerBrowser, steerTerminal, stopTask } from "./helper/tasks.js";
import { editFile, findFiles, readFile, writeFile } from "./files/files.js";

/**
 * Every tool defined by a zod schema and a handler, in the order agents see them. Which
 * tools an agent and the router hold is declared in runtime/tool-set.ts, together with the
 * tools (send_message, yield, memory, list_agents, manage_agent, modify_agent_prompt)
 * that have no definition here.
 */
const definitions = [
  spawnAgent,
  getDevice,
  controlDevice,
  getAgent,
  hathGetLogs,
  getMessages,
  webSearch,
  webFetch,
  setRoutine,
  endRoutine,
  listRoutines,
  remindMe,
  myActivity,
  steerBrowser,
  steerTerminal,
  stopTask,
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
