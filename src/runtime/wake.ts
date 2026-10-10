/**
 * One agent's shared lane history for the current wake.
 *
 * Both lanes read the same record: the system and each lane's transcript
 * window, frozen together when the wake began, then every step either lane took — each model turn whole
 * (thinking, text, tool calls, in provider order) followed by its tool results —
 * plus messages that arrived mid-wake. Only two kinds of turn are lane-private:
 * steers (reasoning's instructions) and intents (conversation's delivery
 * requests), because the other lane already sees the tool call that produced them.
 *
 * Old tool results are dropped first: once the results still shown in full
 * pass a size budget, every result before the newest ones is replaced by a
 * short cleared note. Old turns go only when a lane's prompt would pass its
 * token ceiling: the oldest steps then leave that lane's view behind one
 * trimmed note. Both cuts only move forward and move in one jump, so the
 * history stays byte-stable between cuts and the provider's cached prefix
 * survives every step but the one that cuts. A read of state
 * (a tab's tree, a page's text, a terminal's screen) is also replaced by a short
 * note when a newer read of the same state lands within a few turns of it; the
 * window keeps the cache rewrite that causes inside the provider's lookback.
 *
 * A wake lasts while any lane run for the agent is queued or running, so a
 * steer from conversation reaches a reasoning run that still sees the steer's
 * call. When the last run releases, the record is dropped and the next wake
 * starts from the transcript alone — prior steps cannot few-shot it.
 */

import { HathError } from "../errors.js";
import type { DwarMessage, DwarTool, DwarUsage, Lane } from "../types/domain.js";

/**
 * User turn recorded after a model turn with no tool call, so the lane keeps
 * going. It says the text went nowhere: a model that writes its report as
 * `[To: …]` text believes it was sent, and then waits on a reply that never comes.
 */
export const CONTINUE_TURN =
  "[continue] The text you just wrote reached no one: only a message tool call (send_message or dispatch_message) delivers anything.";

/** What a cleared tool result reads as, in place of its content. */
export const CLEARED_RESULT =
  "[cleared] This older tool result was dropped to keep the wake small. Call the tool again if you still need it.";

/** What a tool result reads as once a newer read of the same state replaces it. */
export const SUPERSEDED_RESULT =
  "[superseded] A newer read of the same page or terminal follows in this wake; use that one.";

/** The turn that stands in for the steps a lane's view trimmed to stay under its token ceiling. */
export const TRIMMED_TURN =
  "[trimmed] Earlier steps of this wake were dropped to keep the prompt small. get_logs has them; redo a step only if you still need its result.";

/**
 * Characters per token when estimating what Hath has not seen measured: a step
 * since the lane's last call, and a lane's first call. Below English's ~4 so
 * tool output (JSON, trees) is not undercounted.
 */
const CHARS_PER_TOKEN = 3;

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
  private frozenSystem: string | null = null;
  private transcripts: Partial<Record<Lane, DwarMessage[]>> | null = null;
  private seenThrough = 0;
  private readonly turns: WakeTurn[] = [];
  /** Turns before this index show their tool results as CLEARED_RESULT. */
  private clearedThrough = 0;
  /** How many turns each lane could see when it last yielded. */
  private readonly yieldedAt = new Map<Lane, number>();
  /** The newest result read under each state key: its turn index and tool_use_id. */
  private readonly latestState = new Map<string, { turn: number; toolUseId: string }>();
  /** tool_use_ids whose results a newer read of the same state replaced. */
  private readonly superseded = new Set<string>();
  /** Per lane, turns before this index are out of its view, behind TRIMMED_TURN. */
  private readonly trimmedThrough = new Map<Lane, number>();
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
      this.turns.push(turn);
      this.supersede(this.turns.length - 1, turn.states ?? {});
    }
    this.clearOldResults();
  }

  /**
   * supersede records the results of turn `index` as the newest read of their state
   * keys, replacing the previous read of each key when it is within the window.
   */
  private supersede(index: number, states: Record<string, string>): void {
    for (const [toolUseId, key] of Object.entries(states)) {
      const previous = this.latestState.get(key);
      if (previous !== undefined && previous.turn >= index - this.limits.supersedeWindowTurns) {
        this.superseded.add(previous.toolUseId);
      }
      this.latestState.set(key, { turn: index, toolUseId });
    }
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
    const trimmed: DwarMessage[] =
      (this.trimmedThrough.get(lane) ?? 0) > 0 ? [{ role: "user", content: TRIMMED_TURN }] : [];
    const turns = this.inView(lane).map((index) => this.shown(index));
    return [...transcript, ...trimmed, ...turns];
  }

  /**
   * fit trims `lane`'s view before a call when its prompt would pass the token
   * ceiling: the oldest steps leave the view until the prompt is promptTrimTokens
   * under the ceiling, keeping at least the newest step. The prompt is the lane's
   * last measured prompt (see measure) plus the estimated turns added since; a
   * lane's first call estimates all of it from `tools` and the frozen text.
   * Throws when the newest step alone still passes the ceiling.
   */
  fit(lane: Lane, tools: DwarTool[]): void {
    const base =
      this.baseTokens.get(lane) ??
      estimateTokens(
        this.system.length +
          JSON.stringify(tools).length +
          this.transcriptFor(lane).reduce((sum, message) => sum + messageChars(message), 0),
      );
    const visible = this.inView(lane);
    const after = visible.map(() => 0);
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      after[i] = this.turnTokens(visible[i]!, lane) + (after[i + 1] ?? 0);
    }
    const total = base + (after[0] ?? 0);
    if (total > this.limits.promptCeilingTokens) {
      const target = this.limits.promptCeilingTokens - this.limits.promptTrimTokens;
      let cut = 0;
      for (let i = 0; i < visible.length; i += 1) {
        if (opensStep(this.turns[visible[i]!]!.message)) {
          cut = i;
          if (base + after[i]! <= target) {
            break;
          }
        }
      }
      const kept = base + (after[cut] ?? 0);
      if (kept > this.limits.promptCeilingTokens) {
        throw new HathError(
          500,
          "internal_error",
          `${lane} prompt is about ${kept} tokens with nothing left to trim, over the ${this.limits.promptCeilingTokens}-token ceiling`,
        );
      }
      this.trimmedThrough.set(lane, visible[cut]!);
    }
    this.sentTurnTokens.set(
      lane,
      this.inView(lane).reduce((sum, index) => sum + this.turnTokens(index, lane), 0),
    );
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

  /** shown is turn `index` as lanes see it, cleared and superseded results swapped for their notes. */
  private shown(index: number): DwarMessage {
    const message = this.turns[index]!.message;
    return index < this.clearedThrough
      ? replaceResults(message, () => CLEARED_RESULT)
      : replaceResults(message, (id) => (this.superseded.has(id) ? SUPERSEDED_RESULT : null));
  }

  /**
   * turnTokens is turn `index`'s weight in `lane`'s prompt: its provider count in the
   * lane that wrote it (untagged turns are the router's own), otherwise estimated from
   * its text, since Dwar shows another lane's turn as a shorter text rendering.
   */
  private turnTokens(index: number, lane: Lane): number {
    const turn = this.turns[index]!;
    const own = turn.message.lane === undefined || turn.message.lane === lane;
    return own && turn.outputTokens !== undefined
      ? turn.outputTokens
      : estimateTokens(messageChars(this.shown(index)));
  }

  /**
   * resultChars is the length every tool result in `message` is shown at, a superseded one
   * as its note.
   */
  private resultChars(message: DwarMessage): number {
    if (typeof message.content === "string") {
      return 0;
    }
    let total = 0;
    for (const block of message.content) {
      if (block.type === "tool_result") {
        total += this.superseded.has(block.tool_use_id)
          ? SUPERSEDED_RESULT.length
          : block.content.length;
      }
    }
    return total;
  }

  /** The wake turns `lane` may see, in order. */
  private visibleTo(lane: Lane): WakeTurn[] {
    return this.turns.filter((turn) => turn.only === undefined || turn.only === lane);
  }

  /**
   * clearOldResults moves the cut when the results shown in full pass
   * toolResultsMaxChars: walking back from the newest turn, it keeps results
   * until the next turn would pass toolResultsKeptChars, and clears the rest.
   */
  private clearOldResults(): void {
    let shown = 0;
    for (let i = this.clearedThrough; i < this.turns.length; i += 1) {
      shown += this.resultChars(this.turns[i]!.message);
    }
    if (shown <= this.limits.toolResultsMaxChars) {
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
  note: (toolUseId: string) => string | null,
): DwarMessage {
  if (
    typeof message.content === "string" ||
    !message.content.some(
      (block) => block.type === "tool_result" && note(block.tool_use_id) !== null,
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
      const replacement = note(block.tool_use_id);
      return replacement === null ? block : { ...block, content: replacement };
    }),
  };
}

/** estimateTokens is roughly how many tokens `chars` characters of prompt cost. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** messageChars is the length of every block of `message` a provider reads. */
function messageChars(message: DwarMessage): number {
  if (typeof message.content === "string") {
    return message.content.length;
  }
  let total = 0;
  for (const block of message.content) {
    if (block.type === "text") {
      total += block.text.length;
    } else if (block.type === "thinking") {
      total += block.thinking.length;
    } else if (block.type === "tool_use") {
      total += JSON.stringify(block.input).length;
    } else if (block.type === "tool_result") {
      total += block.content.length;
    }
  }
  return total;
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
