/**
 * One agent's shared lane history for the current wake.
 *
 * Both lanes read the same record: the system and transcript frozen when the
 * wake began, then every step either lane took — each model turn whole
 * (thinking, text, tool calls, in provider order) followed by its tool results —
 * plus messages that arrived mid-wake. Only two kinds of turn are lane-private:
 * steers (reasoning's instructions) and intents (conversation's delivery
 * requests), because the other lane already sees the tool call that produced them.
 *
 * Turns are never dropped, but old tool results are: once the results still
 * shown in full pass a size budget, every result before the newest ones is
 * replaced by a short cleared note. The cut only moves forward and moves in
 * one jump, so the history stays byte-stable between cuts and the provider's
 * cached prefix survives every step but the one that clears. A read of state
 * (a tab's tree, a page's text, a terminal's screen) is also replaced by a short
 * note when a newer read of the same state lands within a few turns of it; the
 * window keeps the cache rewrite that causes inside the provider's lookback.
 *
 * A wake lasts while any lane run for the agent is queued or running, so a
 * steer from conversation reaches a reasoning run that still sees the steer's
 * call. When the last run releases, the record is dropped and the next wake
 * starts from the transcript alone — prior steps cannot few-shot it.
 */

import type { DwarMessage, Lane } from "../types/domain.js";

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
};

/** One entry in a wake: a user or assistant turn, optionally private to one lane. */
export type WakeTurn = {
  message: DwarMessage;
  /** Set when only one lane should see this turn. */
  only?: Lane;
  /** The state key of each of this turn's tool results that read state, by tool_use_id. */
  states?: Record<string, string>;
};

/** Wake is one agent's shared lane history for the current wake. */
export class Wake {
  private frozenSystem: string | null = null;
  private transcript: DwarMessage[] | null = null;
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

  constructor(private readonly limits: WakeLimits) {}

  /** False until the wake's first lane call freezes the system and transcript. */
  get started(): boolean {
    return this.transcript !== null;
  }

  /**
   * Freeze the system and transcript the wake begins from. The system stays put
   * for the whole wake, so a prompt change (modify_agent_prompt, a new child) lands at
   * the next wake instead of invalidating every cached step of this one.
   */
  begin(system: string, transcript: DwarMessage[], throughSeq: number): void {
    this.frozenSystem = system;
    this.transcript = transcript;
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
   * What `lane` sends to its provider: the frozen transcript, its last turn
   * marked as a cache breakpoint (the next wake opens on the same transcript),
   * then every turn the lane may see, with cleared results swapped out.
   */
  view(lane: Lane): DwarMessage[] {
    const frozen = this.transcript;
    if (frozen === null) {
      throw new Error("wake has not begun");
    }
    const transcript = frozen.map((message, index) =>
      index === frozen.length - 1 ? { ...message, cache_breakpoint: true } : message,
    );
    const turns = this.turns.flatMap((turn, index) => {
      if (turn.only !== undefined && turn.only !== lane) {
        return [];
      }
      return [
        index < this.clearedThrough
          ? replaceResults(turn.message, () => CLEARED_RESULT)
          : replaceResults(turn.message, (id) =>
              this.superseded.has(id) ? SUPERSEDED_RESULT : null,
            ),
      ];
    });
    return [...transcript, ...turns];
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
