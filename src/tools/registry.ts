import type { ToolDefinition } from "./types.js";
import { accessibilityTree } from "./browser/accessibility-tree.js";
import { click } from "./browser/click.js";
import { closeBrowser } from "./browser/close-browser.js";
import { closeTab } from "./browser/close-tab.js";
import { extractText } from "./browser/extract-text.js";
import { listBrowsers } from "./browser/list-browsers.js";
import { listTabs } from "./browser/list-tabs.js";
import { navigate } from "./browser/navigate.js";
import { newTab } from "./browser/new-tab.js";
import { pressKey } from "./browser/press-key.js";
import { screenshot } from "./browser/screenshot.js";
import { selectOption } from "./browser/select.js";
import { spawnBrowser } from "./browser/spawn-browser.js";
import { typeText } from "./browser/type.js";
import { uploadFile } from "./browser/upload-file.js";
import { waitFor } from "./browser/wait-for.js";
import { spawnAgent } from "./hath/spawn-agent.js";
import { getAgent } from "./hath/get-agent.js";
import { grantTool } from "./hath/grant-tool.js";
import { revokeTool } from "./hath/revoke-tool.js";
import { listTools } from "./hath/list-tools.js";
import { scheduleMessage } from "./hath/schedule-message.js";
import { listSchedules } from "./hath/list-schedules.js";
import { cancelSchedule } from "./hath/cancel-schedule.js";
import { getLogs as hathGetLogs } from "./hath/get-logs.js";
import { listDevices } from "./ghar/list-devices.js";
import { getState } from "./ghar/get-state.js";
import { controlDevice } from "./ghar/control-device.js";
import { getDeviceEvents } from "./ghar/get-device-events.js";
import { listItems } from "./chaavi/list-items.js";
import { createLogin } from "./chaavi/create-login.js";
import { fillLogin } from "./chaavi/fill-login.js";
import { fillPasskey } from "./chaavi/fill-passkey.js";
import { fillSecret } from "./chaavi/fill-secret.js";
import { getStatus as nasGetStatus } from "./nas/get-status.js";
import { getLogs as nasGetLogs } from "./nas/get-logs.js";
import { restartModule } from "./nas/restart-module.js";
import { pullUpdates } from "./nas/pull-updates.js";
import { getUpdateStatus as nasGetUpdateStatus } from "./nas/get-update-status.js";
import { stackUp } from "./nas/stack-up.js";
import { stackDown } from "./nas/stack-down.js";
import { provision } from "./nas/provision.js";
import { listClients } from "./nas/list-clients.js";
import { getInfo as deviceGetInfo } from "./device/get-info.js";
import { getBattery as deviceGetBattery } from "./device/get-battery.js";
import { getLocation as deviceGetLocation } from "./device/get-location.js";
import { getNetwork as deviceGetNetwork } from "./device/get-network.js";
import { closeTerminal } from "./terminal/close-terminal.js";
import { editFile } from "./terminal/edit-file.js";
import { executeShell } from "./terminal/execute-shell.js";
import { globFiles } from "./terminal/glob.js";
import { grepFiles } from "./terminal/grep.js";
import { listTerminals } from "./terminal/list-terminals.js";
import { readFile } from "./terminal/read-file.js";
import { readTerminal } from "./terminal/read-terminal.js";
import { sendKeys } from "./terminal/send-keys.js";
import { spawnTerminal } from "./terminal/spawn-terminal.js";
import { writeFile } from "./terminal/write-file.js";
import { getNodeHistory } from "./yaad/get-node-history.js";
import { searchHistory } from "./yaad/search-history.js";

/**
 * Every grantable tool: what an agent's job is. Embedded lane plumbing
 * (send_message, dispatch_message, steer_reasoning, yield, list_agents, memory,
 * manage_agent, modify_agent_prompt) and the embedded agent-management and scheduling tools below are deliberately
 * NOT here — they are not grantable and never appear in the tools table.
 */
const definitions = [
  spawnAgent,
  getNodeHistory,
  searchHistory,
  listDevices,
  getState,
  controlDevice,
  getDeviceEvents,
  listItems,
  createLogin,
  fillLogin,
  fillPasskey,
  fillSecret,
  spawnTerminal,
  listTerminals,
  closeTerminal,
  executeShell,
  readTerminal,
  sendKeys,
  readFile,
  writeFile,
  editFile,
  globFiles,
  grepFiles,
  spawnBrowser,
  listBrowsers,
  closeBrowser,
  listTabs,
  newTab,
  closeTab,
  navigate,
  accessibilityTree,
  click,
  pressKey,
  typeText,
  uploadFile,
  selectOption,
  waitFor,
  screenshot,
  extractText,
  nasGetStatus,
  nasGetLogs,
  restartModule,
  pullUpdates,
  nasGetUpdateStatus,
  stackUp,
  stackDown,
  provision,
  listClients,
  deviceGetInfo,
  deviceGetBattery,
  deviceGetLocation,
  deviceGetNetwork,
] as unknown as ToolDefinition[];

const byName = new Map<string, ToolDefinition>();
for (const definition of definitions) {
  if (byName.has(definition.name)) {
    throw new Error(`duplicate tool name in registry: ${definition.name}`);
  }
  byName.set(definition.name, definition);
}

/** Every grantable tool definition. */
export function allTools(): ToolDefinition[] {
  return definitions;
}

/** The grantable tool with this name, if any. */
export function findTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}

/**
 * Agent-management tools every agent holds without a grant: managing your own
 * children's tools and reading yourself and them is a general rule, not a job.
 * Each handler scopes itself to the caller and its direct children; for the
 * router, the root agents are its children.
 */
const embeddedDefinitions = [
  getAgent,
  grantTool,
  revokeTool,
  listTools,
  hathGetLogs,
] as unknown as ToolDefinition[];

/**
 * Scheduling tools every agent holds without a grant, so each agent automates its
 * own work. Not the router's: a schedule is sent from, and owned by, an agent.
 */
const schedulingDefinitions = [
  scheduleMessage,
  listSchedules,
  cancelSchedule,
] as unknown as ToolDefinition[];

const embeddedByName = new Map<string, ToolDefinition>();
for (const definition of [...embeddedDefinitions, ...schedulingDefinitions]) {
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

/** Look up an embedded agent-management or scheduling tool by name; grantable tools use findTool. */
export function findEmbeddedTool(name: string): ToolDefinition | undefined {
  return embeddedByName.get(name);
}
