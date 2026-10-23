/**
 * Action records: hath's own account of what a reasoning lane did inside one wake, built
 * from its tool calls and their results. A lane's view trims its oldest steps at the
 * prompt ceiling, and the `[trimmed]` note that stands in for them lists the actions those
 * steps took (see wake.ts), so a trimmed lane never redoes a click or a send it can no
 * longer see. Across wakes, the agent's tool log (get_logs) holds what it did.
 */

import type { DwarContentBlock, DwarMessage, DwarToolResultBlock, DwarToolUseBlock } from "../types/domain.js";
import {
  CREATE_ATTACHMENT,
  DECLINE_HANDOFF,
  FORWARD_ATTACHMENT,
  HAND_OFF,
  INGEST_MEMORY,
  LIST_AGENTS,
  MANAGE_AGENT,
  MODIFY_AGENT_PROMPT,
  READ_RESULT,
  SEND_MESSAGE,
  SPAWN_AGENT,
  WAIT,
  YIELD,
} from "../types/domain.js";

/**
 * Tools whose calls change something outside the wake — a page, a file, an account,
 * a device, an agent, a schedule, memory — so a record shows their outcome. Every other
 * recorded call is a read, which a record shows by its size.
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
  HAND_OFF,
  DECLINE_HANDOFF,
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

/**
 * Calls a record leaves out: ending or pausing a turn, a send (the transcript already
 * holds the message), reopening a result, and the roster.
 */
export const UNRECORDED_TOOLS = new Set<string>([YIELD, WAIT, SEND_MESSAGE, READ_RESULT, LIST_AGENTS]);

/** How much of a read's input a record keeps: enough to name what was read. */
const READ_INPUT_CHARS = 120;

/**
 * The outcome of one call: its result, marked when it failed. `chars` is the result's
 * full length when `content` holds only its opening (hydration reads a prefix).
 */
export type ActionResult = Pick<DwarToolResultBlock, "content" | "is_error"> & { chars?: number };

/**
 * stepActions is one model turn as a record shows it: the turn's text, then each call
 * it made (UNRECORDED_TOOLS aside). An action shows its clipped input and outcome; a
 * read shows what it read and how large the result was, since its content is what
 * fills a prompt. A result too long to show whole names the id read_result reopens it
 * by, so a later wake reads it back instead of running the tool again. With
 * `actionsOnly` (a trimmed note, which must stay small inside the wake) reads are left
 * out. Null when the turn made no call the record shows.
 */
export function stepActions(
  content: DwarContentBlock[],
  results: Map<string, ActionResult>,
  actionsOnly = false,
): string | null {
  const calls = content.filter(
    (block): block is DwarToolUseBlock =>
      block.type === "tool_use" &&
      !UNRECORDED_TOOLS.has(block.name) &&
      (!actionsOnly || ACTION_TOOLS.has(block.name)),
  );
  if (calls.length === 0) {
    return null;
  }
  const text = oneLine(content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" "));
  const lines = calls.map((call) => {
    const result = results.get(call.id);
    if (result === undefined) {
      return `  ${call.name} ${clip(JSON.stringify(call.input), CALL_INPUT_CHARS)} → ${NO_RESULT}`;
    }
    const chars = result.chars ?? result.content.length;
    const outcome = oneLine(result.content);
    if (result.is_error || chars <= CALL_RESULT_CHARS) {
      return `  ${call.name} ${clip(JSON.stringify(call.input), ACTION_TOOLS.has(call.name) ? CALL_INPUT_CHARS : READ_INPUT_CHARS)} → ${result.is_error ? "error: " : ""}${clip(outcome, CALL_RESULT_CHARS)}`;
    }
    if (ACTION_TOOLS.has(call.name)) {
      return `  ${call.name} ${clip(JSON.stringify(call.input), CALL_INPUT_CHARS)} → ${outcome.slice(0, CALL_RESULT_CHARS)}… (${chars} chars, read_result ${call.id})`;
    }
    return `  ${call.name} ${clip(JSON.stringify(call.input), READ_INPUT_CHARS)} → read ${chars} chars (read_result ${call.id})`;
  });
  return [text.length > 0 ? clip(text, STEP_TEXT_CHARS) : "(no note)", ...lines].join("\n");
}

/**
 * formatActions lists, oldest first, every step of the reasoning lane in `turns` that
 * called an action tool, with its actions only (see stepActions). Past RECORD_MAX_CHARS it keeps the newest
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
    const step = stepActions(turn.content, results, true);
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
