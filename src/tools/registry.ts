import type { ToolDefinition } from "./types.js";
import { spawnAgent } from "./hath/spawn-agent.js";
import { getAgent } from "./hath/get-agent.js";
import { scheduleMessage } from "./hath/schedule-message.js";
import { listSchedules } from "./hath/list-schedules.js";
import { cancelSchedule } from "./hath/cancel-schedule.js";
import { getLogs as hathGetLogs } from "./hath/get-logs.js";
import { webFetch, webSearch } from "./web/web.js";
import { listDevices } from "./ghar/list-devices.js";
import { getState } from "./ghar/get-state.js";
import { controlDevice } from "./ghar/control-device.js";
import { getDeviceEvents } from "./ghar/get-device-events.js";
import { listBrowsers, listTerminals, steerBrowser, steerTerminal } from "./helper/tasks.js";
import { editFile, findFiles, readFile, writeFile } from "./files/files.js";

/**
 * The registry: the house tools and spawn_agent. Every agent's work lane holds all of them
 * plus the embedded tools below; there are no grants. Lane plumbing (send, message,
 * steer_work, yield, list_agents, memory, manage_agent, modify_agent_prompt) is not here.
 * No tool here or below drives a browser or a shell: that is only the helpers' in Nas,
 * reached through steer_browser and steer_terminal.
 */
const definitions = [
  spawnAgent,
  listDevices,
  getState,
  controlDevice,
  getDeviceEvents,
] as unknown as ToolDefinition[];

const byName = new Map<string, ToolDefinition>();
for (const definition of definitions) {
  if (byName.has(definition.name)) {
    throw new Error(`duplicate tool name in registry: ${definition.name}`);
  }
  byName.set(definition.name, definition);
}

/** Every registry tool definition. */
export function allTools(): ToolDefinition[] {
  return definitions;
}

/** The registry tool with this name, if any. */
export function findTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}

/**
 * Agent-management tools every agent holds: reading yourself and your children is a
 * general rule, not a job. Each handler scopes itself to the caller and its direct
 * children; for the router, the root agents are its children.
 */
const embeddedDefinitions = [
  getAgent,
  hathGetLogs,
  webSearch,
  webFetch,
] as unknown as ToolDefinition[];

/**
 * Scheduling tools every agent holds, so each agent automates its
 * own work. Not the router's: a schedule is sent from, and owned by, an agent.
 */
const schedulingDefinitions = [
  scheduleMessage,
  listSchedules,
  cancelSchedule,
] as unknown as ToolDefinition[];

/**
 * Helper tools every agent's work lane holds: browser and terminal work goes
 * to a helper task in Nas. Not the router's. (list_browsers and list_terminals reach the
 * process lane in the lane overhaul.)
 */
const helperDefinitions = [steerBrowser, steerTerminal, listBrowsers, listTerminals] as unknown as ToolDefinition[];

/** File tools both lanes hold: read and search files on the box. */
const fileReadDefinitions = [readFile, findFiles] as unknown as ToolDefinition[];

/** File tools only the work lane holds: change files on the box. */
const fileWriteDefinitions = [writeFile, editFile] as unknown as ToolDefinition[];

const embeddedByName = new Map<string, ToolDefinition>();
for (const definition of [
  ...embeddedDefinitions,
  ...schedulingDefinitions,
  ...helperDefinitions,
  ...fileReadDefinitions,
  ...fileWriteDefinitions,
]) {
  if (byName.has(definition.name) || embeddedByName.has(definition.name)) {
    throw new Error(`duplicate tool name in registry: ${definition.name}`);
  }
  embeddedByName.set(definition.name, definition);
}

/** Embedded agent-management tools, in the order agents see them. */
export function embeddedAgentTools(): ToolDefinition[] {
  return embeddedDefinitions;
}

/** Embedded scheduling tools, in the order agents see them. */
export function embeddedSchedulingTools(): ToolDefinition[] {
  return schedulingDefinitions;
}

/** Embedded helper tools, in the order agents see them. */
export function embeddedHelperTools(): ToolDefinition[] {
  return helperDefinitions;
}

/** File tools both lanes hold, in the order agents see them. */
export function embeddedFileReadTools(): ToolDefinition[] {
  return fileReadDefinitions;
}

/** File tools the work lane also holds, in the order agents see them. */
export function embeddedFileWriteTools(): ToolDefinition[] {
  return fileWriteDefinitions;
}

/** Look up an embedded agent-management, task or scheduling tool by name; registry tools use findTool. */
export function findEmbeddedTool(name: string): ToolDefinition | undefined {
  return embeddedByName.get(name);
}
