/**
 * Wake records: hath's own account of what a wake's reasoning lane did to the
 * world, built from its tool calls and their results. The wake that took the steps
 * keeps them only while it lasts, and a lane's view trims its oldest steps at the
 * prompt ceiling, so without a record the agent later sees only its own claims about
 * what it did and, with nothing behind them, retracts true reports.
 */

import type { DwarMessage, DwarToolResultBlock, DwarToolUseBlock } from "../types/domain.js";
import {
  CREATE_ATTACHMENT,
  FORWARD_ATTACHMENT,
  INGEST_MEMORY,
  MANAGE_AGENT,
  MODIFY_AGENT_PROMPT,
  SPAWN_AGENT,
} from "../types/domain.js";

/**
 * Tools whose calls change something outside the wake — a page, a file, an account,
 * a device, an agent, a schedule, memory — and so are what a record lists. Reads,
 * waits and hand-offs are left out: a read changes nothing, and a hand-off becomes a
 * message the transcript already holds.
 */
const ACTION_TOOLS = new Set<string>([
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_select",
  "browser_upload_file",
  "browser_new_tab",
  "browser_close_tab",
  "browser_close",
  "browser_spawn",
  "terminal_spawn",
  "terminal_close",
  "terminal_execute_shell",
  "terminal_send_keys",
  "terminal_write_file",
  "terminal_edit_file",
  "chaavi_create_login",
  "chaavi_fill_card",
  "chaavi_fill_login",
  "chaavi_fill_passkey",
  "chaavi_fill_secret",
  "chaavi_save_secret",
  "ghar_control_device",
  "grant_tool",
  "revoke_tool",
  "schedule_message",
  "cancel_schedule",
  "nas_provision",
  "nas_pull_updates",
  "nas_restart_module",
  "nas_stack_up",
  "nas_stack_down",
  SPAWN_AGENT,
  MANAGE_AGENT,
  MODIFY_AGENT_PROMPT,
  INGEST_MEMORY,
  CREATE_ATTACHMENT,
  FORWARD_ATTACHMENT,
]);

/** How much of a step's own text a record keeps: what the lane said it was doing. */
const STEP_TEXT_CHARS = 240;

/** How much of a call's input a record keeps: enough to name the target and typed text. */
const CALL_INPUT_CHARS = 200;

/** How much of a call's result a record keeps: one line of outcome. */
const CALL_RESULT_CHARS = 160;

/** A record keeps its newest steps up to about this many characters. */
const RECORD_MAX_CHARS = 6_000;

/**
 * The opening of the transcript note that holds a finished wake's record, after the
 * runtime prefix: it names hath as its author so the agent reads it as evidence, not
 * as a claim of its own to doubt.
 */
export const WAKE_RECORD_HEADER =
  "Wake record, written by hath from my tool log, not a message: the actions my reasoning lane took in the wake that ended here, each with its result. These calls ran.";

/**
 * formatActions lists, oldest first, every step of the reasoning lane in `turns` that
 * called an action tool: the step's text, then each such call with its clipped input and
 * result. Past RECORD_MAX_CHARS it keeps the newest steps and says how many earlier ones
 * get_logs holds. Null when no step acted.
 */
export function formatActions(turns: DwarMessage[]): string | null {
  const results = new Map<string, DwarToolResultBlock>();
  for (const turn of turns) {
    if (turn.role === "user" && typeof turn.content !== "string") {
      for (const block of turn.content) {
        if (block.type === "tool_result") {
          results.set(block.tool_use_id, block);
        }
      }
    }
  }

  const steps: string[] = [];
  for (const turn of turns) {
    if (turn.role !== "assistant" || turn.lane !== "reasoning" || typeof turn.content === "string") {
      continue;
    }
    const actions = turn.content.filter(
      (block): block is DwarToolUseBlock => block.type === "tool_use" && ACTION_TOOLS.has(block.name),
    );
    if (actions.length === 0) {
      continue;
    }
    const text = oneLine(
      turn.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join(" "),
    );
    const lines = actions.map((action) => {
      const result = results.get(action.id);
      if (result === undefined) {
        throw new Error(`wake record: ${action.name} call ${action.id} has no result`);
      }
      const outcome = `${result.is_error ? "error: " : ""}${clip(oneLine(result.content), CALL_RESULT_CHARS)}`;
      return `  ${action.name} ${clip(JSON.stringify(action.input), CALL_INPUT_CHARS)} → ${outcome}`;
    });
    steps.push([`- ${text.length > 0 ? clip(text, STEP_TEXT_CHARS) : "(no note)"}`, ...lines].join("\n"));
  }
  if (steps.length === 0) {
    return null;
  }

  const kept: string[] = [];
  let size = 0;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (kept.length > 0 && size + step.length > RECORD_MAX_CHARS) {
      break;
    }
    kept.unshift(step);
    size += step.length + 1;
  }
  const omitted = steps.length - kept.length;
  return omitted > 0
    ? [`(${omitted} earlier step${omitted === 1 ? "" : "s"} with actions are left out; get_logs has them)`, ...kept].join("\n")
    : kept.join("\n");
}

/** oneLine collapses `text`'s whitespace runs, newlines included, to single spaces. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** clip cuts `text` to `limit` characters and says how long it was. */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (${text.length} chars)`;
}
