/**
 * Action records: hath's own account of what an agent's reasoning lane did to the
 * world, built from its tool calls and their results. A wake keeps its steps only
 * while it lasts, and a lane's view trims its oldest steps at the prompt ceiling, so
 * without a record the agent later sees only its own claims about what it did and,
 * with nothing behind them, retracts true reports. Each step that acted joins the
 * agent's transcript as a `[Did]` entry (see context.ts), and a `[trimmed]` note lists
 * the actions of the steps it stands in for (see wake.ts).
 */

import type { DwarContentBlock, DwarMessage, DwarToolResultBlock, DwarToolUseBlock } from "../types/domain.js";
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
 * waits and sends are left out: a read changes nothing, and a send is a message the
 * transcript already holds.
 */
export const ACTION_TOOLS = new Set<string>([
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

/** A trimmed note keeps its newest steps up to about this many characters. */
const RECORD_MAX_CHARS = 6_000;

/** What a call reads as when hath stopped before its result was logged. */
const NO_RESULT = "no result (hath stopped before it returned)";

/** The outcome of one call: its result clipped to a line, marked when it failed. */
export type ActionResult = Pick<DwarToolResultBlock, "content" | "is_error">;

/**
 * stepActions is one model turn's actions as a record shows them: the turn's text, then
 * each action call with its clipped input and the clipped outcome `results` holds for it
 * by tool_use_id. Null when the turn called no action tool.
 */
export function stepActions(content: DwarContentBlock[], results: Map<string, ActionResult>): string | null {
  const actions = content.filter(
    (block): block is DwarToolUseBlock => block.type === "tool_use" && ACTION_TOOLS.has(block.name),
  );
  if (actions.length === 0) {
    return null;
  }
  const text = oneLine(content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" "));
  const lines = actions.map((action) => {
    const result = results.get(action.id);
    const outcome =
      result === undefined
        ? NO_RESULT
        : `${result.is_error ? "error: " : ""}${clip(oneLine(result.content), CALL_RESULT_CHARS)}`;
    return `  ${action.name} ${clip(JSON.stringify(action.input), CALL_INPUT_CHARS)} → ${outcome}`;
  });
  return [text.length > 0 ? clip(text, STEP_TEXT_CHARS) : "(no note)", ...lines].join("\n");
}

/**
 * formatActions lists, oldest first, every step of the reasoning lane in `turns` that
 * called an action tool (see stepActions). Past RECORD_MAX_CHARS it keeps the newest
 * steps and says how many earlier ones get_logs holds. Null when no step acted.
 */
export function formatActions(turns: DwarMessage[]): string | null {
  const results = new Map<string, ActionResult>();
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
    const step = stepActions(turn.content, results);
    if (step !== null) {
      steps.push(`- ${step}`);
    }
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
