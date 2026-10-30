/**
 * The agent's way to browsers and terminals: steering a helper task in Nas, and listing the
 * tasks there. The helper does the work and its report comes back as a message that wakes
 * the agent (see runtime/helper-reports.ts); nothing here drives a browser or shell.
 */

import { z } from "zod";
import type { HelperTask, TaskKind } from "../../nas/client.js";
import { defineTool } from "../types.js";
import { fail, failWithoutAgentIdentity, ok, type ToolContext } from "../shared.js";

/** parseTaskAddress is the kind and id in `task/<kind>/<id>`, or null when `address` is not one. */
export function parseTaskAddress(address: string): { kind: TaskKind; id: string } | null {
  const found = /^task\/(browser|terminal)\/([^/\s]+)$/.exec(address);
  return found === null ? null : { kind: found[1] as TaskKind, id: found[2]! };
}

/** taskId is the id inside `id`, which is either a bare id or the task's whole address; null when it names the other kind. */
function taskId(kind: TaskKind, id: string): string | null {
  const address = parseTaskAddress(id);
  if (address === null) {
    return id;
  }
  return address.kind === kind ? address.id : null;
}

const steerInput = z.object({ id: z.string().min(1).optional(), message: z.string().min(1) }).strict();

const steerTerminalInput = steerInput
  .extend({ workdir: z.string().refine((path) => path.startsWith("/"), "workdir must be an absolute path").optional() })
  .strict();

const idProperty = (kind: TaskKind) => ({
  type: "string",
  description: `The id of a ${kind} task from list_${kind}s or an earlier steer_${kind}; leave out to start a new one`,
});

/** Start a browser task or steer one. */
export const steerBrowser = defineTool({
  name: "steer_browser",
  description:
    "Get work done in a real browser and carry on: it returns { id } at once, and when the browser's helper has finished, needs something from you, or failed, its report arrives as a message that wakes you, with any files it downloaded. With no id it starts a new browser task on message. With an id it steers that task, waking it if it was asleep; its tabs, sign-ins and history are as they were. The helper signs in from the vault, clicks, fills and submits forms, downloads and uses as many tabs as it needs. Use it for anything behind a sign-in or that needs clicking, forms or several steps; web_search and web_fetch answer public pages at once. list_browsers shows what is open, so you can reuse a task instead of starting another.",
  input: steerInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: {
      id: idProperty("browser"),
      message: {
        type: "string",
        description: "What to get done with every detail it needs (where to start, accounts, dates, what to bring back), or the next step, correction or answer for a task already running",
      },
    },
  },
  async handler(ctx, parsed) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    return steer(ctx, "browser", parsed.id, { agent_id: ctx.callerId, message: parsed.message });
  },
});

/** Start a terminal task or steer one. */
export const steerTerminal = defineTool({
  name: "steer_terminal",
  description:
    "Get work done on the box (Dadi's Linux host) in a shell and carry on: it returns { id } at once, and when the terminal's helper has finished, needs something from you, or failed, its report arrives as a message that wakes you, with any files it handed back. With no id it starts a new terminal task on message, in workdir (default the dadi home). With an id it steers that task, waking it if it was asleep. The helper runs commands, builds, tests, git and package managers, edits files and uses vault secrets without seeing them. For one file read, one edit or one search use read_file, edit_file and find, which answer at once. list_terminals shows what is open.",
  input: steerTerminalInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: {
      id: idProperty("terminal"),
      message: {
        type: "string",
        description: "What to get done with every detail it needs, or the next step, correction or answer for a task already running",
      },
      workdir: { type: "string", description: "Absolute directory a new task starts in (default the dadi home)" },
    },
  },
  async handler(ctx, parsed) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    return steer(ctx, "terminal", parsed.id, {
      agent_id: ctx.callerId,
      message: parsed.message,
      ...(parsed.workdir !== undefined ? { cwd: parsed.workdir } : {}),
    });
  },
});

/** steer starts a task of `kind`, or steers the one `id` names, and returns its address. */
async function steer(
  ctx: ToolContext,
  kind: TaskKind,
  id: string | undefined,
  body: { agent_id: string; message: string; cwd?: string },
) {
  let task: HelperTask;
  if (id === undefined) {
    task = await ctx.nas.startTask(kind, body);
  } else {
    const bare = taskId(kind, id);
    if (bare === null) {
      return fail(`${id} is not a ${kind} task`);
    }
    task = await ctx.nas.steerTask(kind, bare, body);
  }
  ctx.events.emit({ type: "sessions_changed", at: new Date().toISOString() });
  return ok({ id: task.task }, { task: task.task });
}

const listInput = z.object({}).strict();

/** minutesSince is whole minutes from the ISO time `at` to now. */
function minutesSince(at: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60_000));
}

/** listTool is the list tool for tasks of one kind. */
function listTool(kind: TaskKind, current: string) {
  return defineTool({
    name: `list_${kind}s`,
    description: `List every ${kind} task open on the box, whoever started it: id, status (working, idle, asking for something, or asleep), owner, purpose, ${current} and minutes since it last did anything. Use it to find a task to steer with steer_${kind} instead of starting another.`,
    input: listInput,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    async handler(ctx) {
      const tasks = (await ctx.nas.listTasks()).filter((task) => task.kind === kind);
      return ok({
        [`${kind}s`]: tasks.map((task) => ({
          id: task.task,
          status: task.status,
          owner: task.owner,
          purpose: task.purpose,
          current: task.state,
          idle_minutes: minutesSince(task.last_activity),
        })),
      });
    },
  });
}

/** List browser tasks. */
export const listBrowsers = listTool("browser", "the page it is on");

/** List terminal tasks. */
export const listTerminals = listTool("terminal", "the directory and files it has touched");
