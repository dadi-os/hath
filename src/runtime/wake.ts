/**
 * One agent's shared lane history for the current wake.
 *
 * Both lanes read the same record: the system and each lane's transcript
 * window, frozen together when the wake began, then every step either lane took — each model turn whole
 * (thinking, text, tool calls, in provider order) followed by its tool results —
 * plus messages that arrived mid-wake. Only a few kinds of turn are lane-private:
 * steers (the work lane's instructions), because the process lane already sees the call that
 * produced them, and each lane's own reminders.
 *
 * Old tool results are dropped first: once the results still shown in full
 * pass a size budget, every result before the newest ones is replaced by a
 * receipt naming the call, its size and how it began, with the id read_result
 * reads it back by, so a lane reopens a result instead of running the tool again. When a lane's prompt would pass its token ceiling, the
 * thinking of every model turn before its newest leaves that lane's view first,
 * since the calls and text it led to stay; only if that is not enough do the
 * oldest steps leave behind one trimmed note that lists the actions they took (see
 * record.ts), so a trimmed lane never redoes a send it can no longer see. The cuts
 * only move forward and move in one jump, so the history stays byte-stable
 * between cuts and the provider's cached prefix survives every step but the one
 * that cuts. A read of state
 * (a tab's tree, a page's text, a terminal's screen) that a newer read of the same
 * state follows within a few turns is replaced by a short note at the next cut,
 * never on its own: every cached prefix since the older read holds it whole, so
 * replacing it mid-wake would rewrite all of them.
 *
 * A wake lasts while any lane run for the agent is queued or running, so a
 * steer from the process lane reaches a work-lane run that still sees the steer's
 * call. When the last run releases, the record is dropped and the next wake
 * starts from the transcript alone — prior steps cannot few-shot it. What earlier wakes
 * did is in the agent's tool log, which get_logs searches.
 */

import { randomUUID } from "node:crypto";
import { HathError } from "../errors.js";
import type { DwarMessage, DwarTool, DwarUsage, Lane } from "../types/domain.js";
import { formatActions } from "./record.js";

/**
 * User turn recorded after a model turn with no tool call, so the lane keeps
 * going. It says the text went nowhere: a model that writes its report as
 * `[To: …]` text believes it was sent, and then waits on a reply that never comes.
 */
export const CONTINUE_TURN =
  "[continue] The text you just wrote reached no one: only a message tool call (hand_off, send_message or dispatch_message) delivers anything.";

/**
 * User turn recorded after a turn that ran out of output room while thinking and did
 * nothing. Its thinking is not kept, so without this the lane plans the same thing from
 * the start and runs out again: schedule-specialist did that 32 times on 2026-10-18,
 * about two and a half minutes a turn, laying out a week in its head.
 */
export const CAPPED_TURN =
  "[continue] Your last turn ran out of output room while thinking and did nothing, and that thinking is gone. Do not plan it all again in your head: take the next step now, and for a large piece of work write the plan down first (a file, or a message) and then act on it a part at a time.";

/** How many turns in a row may run out of output room while thinking before the lane stops. */
export const CAPPED_TURNS_MAX = 3;

/** How a cleared tool result's receipt opens (see receipt). */
export const CLEARED_PREFIX = "[cleared]";

/** How an oversized tool result's receipt opens (see receipt). */
export const OVERSIZED_PREFIX = "[too large]";

/** A result this short stays whole when results are cleared: its receipt would save nothing. */
const KEEP_WHOLE_CHARS = 400;

/** How much of a call's input a receipt names. */
const RECEIPT_INPUT_CHARS = 160;

/** How much of a result's opening a receipt keeps. */
const RECEIPT_HEAD_CHARS = 200;

/** A tool call as a receipt names it. */
type CallInfo = { name: string; input: unknown };

/**
 * receipt is what a tool result reads as once it leaves full view: the call that made
 * it, its size, how it began, and the id read_result reads it back by from hath's log,
 * in pages or by a pattern. It is built only from the call and the result, so it is the
 * same bytes on every step and the provider's cached prefix holds.
 */
export function receipt(prefix: string, toolUseId: string, call: CallInfo | undefined, content: string): string {
  const what =
    call === undefined
      ? "This result"
      : `${call.name} ${clipText(JSON.stringify(call.input) ?? "{}", RECEIPT_INPUT_CHARS)}`;
  const why = prefix === OVERSIZED_PREFIX ? "too large for the prompt" : "out of view";
  const head = clipText(content.replace(/\s+/g, " ").trim(), RECEIPT_HEAD_CHARS);
  return `${prefix} ${what} · ${content.length} chars, ${why}. read_result ${toolUseId} reopens it (offset/limit, or pattern) instead of rerunning. Began: ${head}`;
}

/** clipText cuts `text` to `limit` characters, marking the cut. */
function clipText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** What a tool result reads as once a newer read of the same state replaces it. */
export const SUPERSEDED_RESULT =
  "[superseded] A newer read of the same page or terminal follows in this wake; use that one.";


/**
 * The turn that stands in for the steps a lane's view trimmed to stay under its token
 * ceiling. It names hath as its author because Dwar folds it into the user turn of
 * whatever arrived next, where unlabelled it reads as part of that sender's message.
 */
export const TRIMMED_TURN =
  "[trimmed] A note from hath, not a message: earlier steps of this wake were dropped to keep the prompt small. get_logs has them; redo a step only if you still need its result.";

/** Introduces the actions of the trimmed steps, listed after TRIMMED_TURN. */
const TRIMMED_ACTIONS =
  "Actions those dropped steps took, from hath's tool log. They ran; never redo one:";

/**
 * Characters per token of prose (messages, thinking) when estimating what Hath has
 * not seen measured: a step since the lane's last call, a lane's first call, and the
 * room a transcript window has beside the system and tools (see assembleContext).
 * Haiku 5.5 counted 2.37 on a real agent thread (2026-10-10), rounded down.
 */
export const PROSE_CHARS_PER_TOKEN = 2.3;

/**
 * Characters per token of data (tool results, tool inputs, tool schemas): JSON with
 * ids and URLs packs denser than prose, about 1.8 on a 45k-character get_logs result
 * (2026-10-11), rounded down so estimates never undercount.
 */
export const DATA_CHARS_PER_TOKEN = 1.7;

/** How much tool output a wake shows in full before it clears older results. */
export type WakeLimits = {
  /** Clearing starts when the tool results still shown in full pass this many characters. */
  toolResultsMaxChars: number;
  /** A clear keeps the newest results up to this many characters (always at least the newest turn's). */
  toolResultsKeptChars: number;
  /**
   * A newer read of the same state replaces an older one only while the older sits within
   * this many of the newest turns, so the cache rewrite it causes stays short.
   */
  supersedeWindowTurns: number;
  /** A lane's prompt never passes this many tokens: past it, its oldest steps leave its view. */
  promptCeilingTokens: number;
  /** A trim brings the prompt this many tokens under the ceiling, so trims stay rare. */
  promptTrimTokens: number;
};

/** One entry in a wake: a user or assistant turn, optionally private to one lane. */
export type WakeTurn = {
  message: DwarMessage;
  /** Set when only one lane should see this turn. */
  only?: Lane;
  /** The state key of each of this turn's tool results that read state, by tool_use_id. */
  states?: Record<string, string>;
  /**
   * For a model turn, the tokens its provider counted for it (thinking, text and
   * calls): its weight in the producing lane's prompt, which replays it verbatim.
   */
  outputTokens?: number;
};

/** Wake is one agent's shared lane history for the current wake. */
export class Wake {
  /** Stamped on every log row of this wake, so the activity feed groups by wake instead of guessing. */
  readonly id = randomUUID();
  private frozenSystem: string | null = null;
  private transcripts: Partial<Record<Lane, DwarMessage[]>> | null = null;
  private seenThrough = 0;
  private readonly turns: WakeTurn[] = [];
  /** Each tool call in the wake by tool_use_id, so a receipt can name the call behind a result. */
  private readonly calls = new Map<string, CallInfo>();
  /** Turns before this index show their tool results as cleared receipts (see receipt). */
  private clearedThrough = 0;
  /** The ids of the hand-offs already shown to the process lane in this wake. */
  readonly handoffsShown = new Set<number>();
  /** How many turns each lane could see when it last yielded. */
  private readonly yieldedAt = new Map<Lane, number>();
  /** The newest result read under each state key: its turn index and tool_use_id. */
  private readonly latestState = new Map<string, { turn: number; toolUseId: string }>();
  /** tool_use_ids whose results a newer read of the same state replaced. */
  private readonly superseded = new Set<string>();
  /** tool_use_ids a newer read of the same state followed, replaced at the next cut. */
  private readonly pendingSuperseded = new Set<string>();
  /** tool_use_ids whose results were dropped because their step alone passed a prompt ceiling. */
  private readonly oversized = new Set<string>();
  /** Per lane, turns before this index are out of its view, behind TRIMMED_TURN. */
  private readonly trimmedThrough = new Map<Lane, number>();
  /** Per lane, model turns before this index show without their thinking. */
  private readonly unthoughtThrough = new Map<Lane, number>();
  /**
   * Per lane, its last call's measured prompt tokens less the estimated tokens of
   * the wake turns that call sent: the system, tools, doctrine and transcript.
   */
  private readonly baseTokens = new Map<Lane, number>();
  /** Per lane, the estimated tokens of the wake turns its in-flight call sent. */
  private readonly sentTurnTokens = new Map<Lane, number>();

  constructor(private readonly limits: WakeLimits) {}

  /** False until the wake's first lane call freezes the system and transcript. */
  get started(): boolean {
    return this.transcripts !== null;
  }

  /**
   * Freeze the system and each lane's transcript the wake begins from. The system
   * stays put for the whole wake, so a prompt change (modify_agent_prompt, a new child)
   * lands at the next wake instead of invalidating every cached step of this one.
   */
  begin(system: string, transcripts: Partial<Record<Lane, DwarMessage[]>>, throughSeq: number): void {
    this.frozenSystem = system;
    this.transcripts = transcripts;
    this.seenThrough = throughSeq;
  }

  /** The system frozen when the wake began. */
  get system(): string {
    if (this.frozenSystem === null) {
      throw new Error("wake has not begun");
    }
    return this.frozenSystem;
  }

  get throughSeq(): number {
    return this.seenThrough;
  }

  /** Record that transcript entries through `seq` have been folded in. */
  advance(seq: number): void {
    this.seenThrough = seq;
  }

  /**
   * Append turns together, so a model turn and its results are never split by
   * the other lane, replace older reads of the state they read, then clear older
   * tool results if the wake is over budget.
   */
  push(...turns: WakeTurn[]): void {
    for (const turn of turns) {
      if (typeof turn.message.content !== "string") {
        for (const block of turn.message.content) {
          if (block.type === "tool_use") {
            this.calls.set(block.id, { name: block.name, input: block.input });
          }
        }
      }
      this.turns.push(turn);
      this.supersede(this.turns.length - 1, turn.states ?? {});
    }
    this.clearOldResults();
  }

  /**
   * supersede records the results of turn `index` as the newest read of their state
   * keys, queuing the previous read of each key for replacement when it is within the window.
   */
  private supersede(index: number, states: Record<string, string>): void {
    for (const [toolUseId, key] of Object.entries(states)) {
      const previous = this.latestState.get(key);
      if (previous !== undefined && previous.turn >= index - this.limits.supersedeWindowTurns) {
        this.pendingSuperseded.add(previous.toolUseId);
      }
      this.latestState.set(key, { turn: index, toolUseId });
    }
  }

  /** True once the work lane has taken a step in this wake. */
  reasoned(): boolean {
    return this.turns.some((turn) => turn.message.role === "assistant" && turn.message.lane === "work");
  }

  /** Per lane, how many turns in a row ran out of output room while thinking (see CAPPED_TURN). */
  private readonly cappedRuns = new Map<Lane, number>();

  /** noteTurn counts a turn of `lane` toward its run of capped turns, or resets the run; returns the run's length. */
  noteTurn(lane: Lane, capped: boolean): number {
    const run = capped ? (this.cappedRuns.get(lane) ?? 0) + 1 : 0;
    this.cappedRuns.set(lane, run);
    return run;
  }

  /** Record that `lane` yielded with the wake as it stands now. */
  markYield(lane: Lane): void {
    this.yieldedAt.set(lane, this.visibleTo(lane).length);
  }

  /** True when no turn `lane` can see has joined the wake since it last yielded. */
  unchangedSinceYield(lane: Lane): boolean {
    return this.yieldedAt.get(lane) === this.visibleTo(lane).length;
  }

  /**
   * What `lane` sends to its provider: its frozen transcript, the last turn
   * marked as a cache breakpoint (the next wake opens on the same transcript),
   * then every turn the lane may see past its trim, with cleared results
   * swapped out.
   */
  view(lane: Lane): DwarMessage[] {
    const frozen = this.transcriptFor(lane);
    const transcript = frozen.map((message, index) =>
      index === frozen.length - 1 ? { ...message, cache_breakpoint: true } : message,
    );
    const through = this.trimmedThrough.get(lane) ?? 0;
    const trimmed: DwarMessage[] = through > 0 ? [{ role: "user", content: this.trimmedNote(through) }] : [];
    const turns = this.inView(lane).map((index) => this.shown(index, lane));
    return [...transcript, ...trimmed, ...turns];
  }

  /**
   * fit trims `lane`'s view before a call when its prompt would pass the token
   * ceiling: first the thinking of every model turn before the lane's newest goes,
   * then, if the prompt still passes the ceiling, the oldest steps leave the view
   * until it is promptTrimTokens under the ceiling, keeping at least the newest
   * step. The prompt is the lane's
   * last measured prompt (see measure) plus the estimated turns added since; a
   * lane's first call estimates all of it from `tools` and the frozen text.
   * When the newest step alone still passes the ceiling, its largest tool results
   * read as oversized receipts for both lanes until it fits. Throws only when that
   * is still not enough.
   */
  fit(lane: Lane, tools: DwarTool[]): void {
    const base =
      this.baseTokens.get(lane) ??
      Math.ceil(this.system.length / PROSE_CHARS_PER_TOKEN) +
        Math.ceil(JSON.stringify(tools).length / DATA_CHARS_PER_TOKEN) +
        this.transcriptFor(lane).reduce((sum, message) => sum + messageTokens(message), 0);
    if (base + this.viewTokens(lane) > this.limits.promptCeilingTokens) {
      this.applySuperseded();
      this.dropThinking(lane);
    }
    const visible = this.inView(lane);
    const after = visible.map(() => 0);
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      after[i] = this.turnTokens(visible[i]!, lane) + (after[i + 1] ?? 0);
    }
    const total = base + this.noteTokens(this.trimmedThrough.get(lane) ?? 0) + (after[0] ?? 0);
    if (total > this.limits.promptCeilingTokens) {
      const target = this.limits.promptCeilingTokens - this.limits.promptTrimTokens;
      let cut = 0;
      for (let i = 0; i < visible.length; i += 1) {
        if (opensStep(this.turns[visible[i]!]!.message)) {
          cut = i;
          if (base + this.noteTokens(visible[i]!) + after[i]! <= target) {
            break;
          }
        }
      }
      let kept = base + this.noteTokens(visible[cut]!) + (after[cut] ?? 0);
      if (kept > this.limits.promptCeilingTokens) {
        kept = this.dropOversized(visible.slice(cut), kept, lane);
      }
      if (kept > this.limits.promptCeilingTokens) {
        throw new HathError(
          500,
          "internal_error",
          `${lane} prompt is about ${kept} tokens with nothing left to trim, over the ${this.limits.promptCeilingTokens}-token ceiling`,
        );
      }
      this.trimmedThrough.set(lane, visible[cut]!);
    }
    this.sentTurnTokens.set(lane, this.viewTokens(lane));
  }

  /** applySuperseded replaces every queued older read with its note, as part of a cut. */
  private applySuperseded(): void {
    for (const id of this.pendingSuperseded) {
      this.superseded.add(id);
    }
    this.pendingSuperseded.clear();
  }

  /** viewTokens is the weight of every wake turn in `lane`'s view, its trimmed note included. */
  private viewTokens(lane: Lane): number {
    return (
      this.noteTokens(this.trimmedThrough.get(lane) ?? 0) +
      this.inView(lane).reduce((sum, index) => sum + this.turnTokens(index, lane), 0)
    );
  }

  /**
   * trimmedNote is the turn that stands in for turns before `through`: TRIMMED_TURN, then
   * the actions those turns took. It changes only when a cut moves `through`, so the
   * cached prefix holds between cuts.
   */
  private trimmedNote(through: number): string {
    const actions = formatActions(this.turns.slice(0, through).map((turn) => turn.message));
    return actions === null ? TRIMMED_TURN : `${TRIMMED_TURN}\n\n${TRIMMED_ACTIONS}\n${actions}`;
  }

  /** noteTokens is the weight of the trimmed note for a view that starts at turn `through`; none at 0. */
  private noteTokens(through: number): number {
    return through > 0 ? Math.ceil(this.trimmedNote(through).length / PROSE_CHARS_PER_TOKEN) : 0;
  }

  /**
   * dropThinking moves `lane`'s thinking cut to its newest model turn, whose thinking
   * the provider needs to continue the tool loop.
   */
  private dropThinking(lane: Lane): void {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const message = this.turns[i]!.message;
      if (message.role === "assistant" && (message.lane === undefined || message.lane === lane)) {
        this.unthoughtThrough.set(lane, i);
        return;
      }
    }
  }

  /**
   * measure records what `lane`'s last call actually cost in prompt tokens, so the
   * next fit counts the system, tools, doctrine and transcript exactly instead of
   * estimating them.
   */
  measure(lane: Lane, usage: DwarUsage): void {
    const sent = this.sentTurnTokens.get(lane);
    if (sent === undefined) {
      throw new Error(`${lane} measured a call it never fit`);
    }
    const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
    this.baseTokens.set(lane, prompt - sent);
  }

  /** transcriptFor is the transcript frozen for `lane` when the wake began. */
  private transcriptFor(lane: Lane): DwarMessage[] {
    if (this.transcripts === null) {
      throw new Error("wake has not begun");
    }
    const transcript = this.transcripts[lane];
    if (transcript === undefined) {
      throw new Error(`wake has no ${lane} transcript`);
    }
    return transcript;
  }

  /** inView is the index of every turn `lane` may see past its trim, in order. */
  private inView(lane: Lane): number[] {
    const from = this.trimmedThrough.get(lane) ?? 0;
    const out: number[] = [];
    for (let i = from; i < this.turns.length; i += 1) {
      const turn = this.turns[i]!;
      if (turn.only === undefined || turn.only === lane) {
        out.push(i);
      }
    }
    return out;
  }

  /**
   * dropOversized marks the largest tool results in turns `indices` of `lane`'s view,
   * biggest first, as oversized receipts until a prompt of `tokens` fits the ceiling, and
   * returns its new size.
   */
  private dropOversized(indices: number[], tokens: number, lane: Lane): number {
    const results: { id: string; chars: number; saved: number }[] = [];
    for (const index of indices) {
      const message = this.shown(index, lane);
      if (typeof message.content === "string") {
        continue;
      }
      for (const block of message.content) {
        if (block.type !== "tool_result") {
          continue;
        }
        const note = receipt(OVERSIZED_PREFIX, block.tool_use_id, this.calls.get(block.tool_use_id), block.content);
        if (block.content.length > note.length) {
          results.push({ id: block.tool_use_id, chars: block.content.length, saved: block.content.length - note.length });
        }
      }
    }
    results.sort((a, b) => b.chars - a.chars);
    let total = tokens;
    for (const result of results) {
      if (total <= this.limits.promptCeilingTokens) {
        break;
      }
      this.oversized.add(result.id);
      total -= Math.ceil(result.saved / DATA_CHARS_PER_TOKEN);
    }
    return total;
  }

  /**
   * shown is turn `index` as `lane` sees it: thinking dropped behind its thinking cut,
   * cleared, superseded and oversized results swapped for their notes.
   */
  private shown(index: number, lane: Lane): DwarMessage {
    const message = this.unthought(index, lane)
      ? withoutThinking(this.turns[index]!.message)
      : this.turns[index]!.message;
    return index < this.clearedThrough
      ? replaceResults(message, (id, content) => this.clearedNote(id, content))
      : replaceResults(message, (id, content) => this.resultNote(id, content));
  }

  /** clearedNote is what a result behind the clearing cut reads as: its receipt, or itself when short. */
  private clearedNote(toolUseId: string, content: string): string | null {
    if (this.superseded.has(toolUseId)) {
      return SUPERSEDED_RESULT;
    }
    return content.length <= KEEP_WHOLE_CHARS ? null : receipt(CLEARED_PREFIX, toolUseId, this.calls.get(toolUseId), content);
  }

  /** resultNote is what a live tool result reads as instead of its content, or null to show it whole. */
  private resultNote(toolUseId: string, content: string): string | null {
    if (this.oversized.has(toolUseId)) {
      return receipt(OVERSIZED_PREFIX, toolUseId, this.calls.get(toolUseId), content);
    }
    return this.superseded.has(toolUseId) ? SUPERSEDED_RESULT : null;
  }

  /** unthought is true when `lane` sees turn `index` with its thinking dropped. */
  private unthought(index: number, lane: Lane): boolean {
    return index < (this.unthoughtThrough.get(lane) ?? 0) && hasThinking(this.turns[index]!.message);
  }

  /**
   * turnTokens is turn `index`'s weight in `lane`'s prompt: its provider count in the
   * lane that wrote it (untagged turns are the router's own) while it is replayed
   * whole, otherwise estimated from its text, since Dwar shows another lane's turn as
   * a shorter text rendering. A turn that thought replays at about what it billed, not
   * what its visible summary suggests: on 2026-10-18 a schedule-specialist turn showed
   * 20k characters of thinking, billed 25,792 output tokens, and grew the next prompt by
   * 27k; counting the summary instead (from 2026-10-16 to 2026-10-20) let 17 the work lane
   * prompts pass 100k tokens, where Haiku's price rises 5x.
   */
  private turnTokens(index: number, lane: Lane): number {
    const turn = this.turns[index]!;
    const own = turn.message.lane === undefined || turn.message.lane === lane;
    return own && turn.outputTokens !== undefined && !this.unthought(index, lane)
      ? turn.outputTokens
      : messageTokens(this.shown(index, lane));
  }

  /**
   * resultChars is the length every tool result in `message` is shown at, a superseded or
   * oversized one as its note.
   */
  private resultChars(message: DwarMessage): number {
    if (typeof message.content === "string") {
      return 0;
    }
    let total = 0;
    for (const block of message.content) {
      if (block.type === "tool_result") {
        total += (this.resultNote(block.tool_use_id, block.content) ?? block.content).length;
      }
    }
    return total;
  }

  /** shownResultChars is the length of every tool result past the clearing cut, as shown. */
  private shownResultChars(): number {
    let shown = 0;
    for (let i = this.clearedThrough; i < this.turns.length; i += 1) {
      shown += this.resultChars(this.turns[i]!.message);
    }
    return shown;
  }

  /** The wake turns `lane` may see, in order. */
  private visibleTo(lane: Lane): WakeTurn[] {
    return this.turns.filter((turn) => turn.only === undefined || turn.only === lane);
  }

  /**
   * clearOldResults cuts when the results shown in full pass toolResultsMaxChars:
   * first the queued older reads are replaced, and if that is not enough, walking
   * back from the newest turn, it keeps results until the next turn would pass
   * toolResultsKeptChars, and clears the rest.
   */
  private clearOldResults(): void {
    if (this.shownResultChars() <= this.limits.toolResultsMaxChars) {
      return;
    }
    this.applySuperseded();
    if (this.shownResultChars() <= this.limits.toolResultsMaxChars) {
      return;
    }
    let kept = 0;
    let cut = this.turns.length;
    for (let i = this.turns.length - 1; i >= this.clearedThrough; i -= 1) {
      const size = this.resultChars(this.turns[i]!.message);
      if (kept > 0 && kept + size > this.limits.toolResultsKeptChars) {
        break;
      }
      kept += size;
      cut = i;
    }
    this.clearedThrough = cut;
  }
}

/**
 * replaceResults returns `message` with each tool result for which `note` returns text shown
 * as that text instead of its content; `message` itself when none is replaced.
 */
function replaceResults(
  message: DwarMessage,
  note: (toolUseId: string, content: string) => string | null,
): DwarMessage {
  if (
    typeof message.content === "string" ||
    !message.content.some(
      (block) => block.type === "tool_result" && note(block.tool_use_id, block.content) !== null,
    )
  ) {
    return message;
  }
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== "tool_result") {
        return block;
      }
      const replacement = note(block.tool_use_id, block.content);
      return replacement === null ? block : { ...block, content: replacement };
    }),
  };
}

/** hasThinking is true when `message` carries a thinking block and something besides. */
function hasThinking(message: DwarMessage): boolean {
  return (
    typeof message.content !== "string" &&
    message.content.some((block) => block.type === "thinking" || block.type === "redacted_thinking") &&
    message.content.some((block) => block.type !== "thinking" && block.type !== "redacted_thinking")
  );
}

/** withoutThinking returns `message` with its thinking blocks removed. */
function withoutThinking(message: DwarMessage): DwarMessage {
  if (typeof message.content === "string") {
    return message;
  }
  return {
    ...message,
    content: message.content.filter(
      (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
    ),
  };
}

/** messageTokens estimates what every block of `message` a provider reads costs, prose and data at their own rates. */
function messageTokens(message: DwarMessage): number {
  if (typeof message.content === "string") {
    return Math.ceil(message.content.length / PROSE_CHARS_PER_TOKEN);
  }
  let prose = 0;
  let data = 0;
  for (const block of message.content) {
    if (block.type === "text") {
      prose += block.text.length;
    } else if (block.type === "thinking") {
      prose += block.thinking.length;
    } else if (block.type === "tool_use") {
      data += JSON.stringify(block.input).length;
    } else if (block.type === "tool_result") {
      data += block.content.length;
    }
  }
  return Math.ceil(prose / PROSE_CHARS_PER_TOKEN) + Math.ceil(data / DATA_CHARS_PER_TOKEN);
}

/**
 * opensStep is true when a view may start at `message`: anything but the
 * results of a tool call, which must follow the model turn that made it.
 */
function opensStep(message: DwarMessage): boolean {
  return (
    typeof message.content === "string" ||
    !message.content.some((block) => block.type === "tool_result")
  );
}

/** WakeStore holds each agent's current wake and how many lane runs keep it alive. */
export class WakeStore {
  private readonly wakes = new Map<string, Wake>();
  private readonly holds = new Map<string, number>();

  constructor(private readonly limits: WakeLimits) {}

  /** True when exactly one run holds the agent's wake, so releasing it drops the wake. */
  lastHold(agentId: string): boolean {
    return this.holds.get(agentId) === 1;
  }

  /** The id of the agent's current wake, or null when it has none. */
  idOf(agentId: string): string | null {
    return this.wakes.get(agentId)?.id ?? null;
  }

  /** The agent's current wake, created on first use. */
  get(agentId: string): Wake {
    let wake = this.wakes.get(agentId);
    if (!wake) {
      wake = new Wake(this.limits);
      this.wakes.set(agentId, wake);
    }
    return wake;
  }

  /**
   * hold keeps the agent's wake alive for one queued or running lane run.
   * The returned release is idempotent; the wake is dropped when the last
   * hold is released.
   */
  hold(agentId: string): () => void {
    this.holds.set(agentId, (this.holds.get(agentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const held = this.holds.get(agentId);
      if (held === undefined) {
        throw new Error(`wake for ${agentId} released without a hold`);
      }
      const left = held - 1;
      if (left > 0) {
        this.holds.set(agentId, left);
        return;
      }
      this.holds.delete(agentId);
      this.wakes.delete(agentId);
    };
  }
}
