import { motion, useReducedMotion } from "motion/react";
import type { AgentRecord } from "../../../shared/api/types";
import { EASE, SLOW_S } from "../../../shared/lib/ux/motion";
import { formatRelative } from "../format";

export type ThreadEmptyProps = {
  /** Display name for the agent (header title). */
  name: string;
  /** Agent record when loaded; adds spawn time. */
  agent?: AgentRecord;
  /** Fill the composer with a starter prompt. */
  onSuggest: (text: string) => void;
};

const STARTERS = ["What are you working on?", "What can you help me with?"];

/**
 * Placeholder for an agent thread with no messages. Sits centered like
 * DadiHome: a monogram with a slow halo, the agent's name, and starters.
 */
export function ThreadEmpty({ name, agent, onSuggest }: ThreadEmptyProps) {
  const reduced = useReducedMotion() ?? false;
  const spawned = agent ? `Spawned ${formatRelative(agent.created_at)}` : null;

  return (
    <motion.div
      className="flex w-full max-w-[16rem] flex-col items-center"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <div className="relative flex size-16 items-center justify-center">
        <motion.span
          className="absolute inset-0 rounded-full border border-sage-line/70"
          animate={
            reduced ? undefined : { scale: [1, 1.22, 1], opacity: [0.7, 0, 0.7] }
          }
          transition={
            reduced
              ? undefined
              : { duration: 3.2, repeat: Infinity, ease: EASE }
          }
          aria-hidden
        />
        <span className="relative flex size-full items-center justify-center rounded-full border border-sage-line/60 bg-sage-fill text-[21px] font-medium tracking-[0.02em] text-sage-deep">
          {monogram(name)}
        </span>
      </div>
      <p className="mt-5 max-w-full truncate text-[16px] font-medium text-ink">
        {name}
      </p>
      {spawned ? (
        <p className="mt-1 text-[11px] tracking-[0.12em] text-ink-ghost uppercase">
          {spawned}
        </p>
      ) : null}
      <p className="mt-4 text-center text-[13px] leading-relaxed tracking-[0.02em] text-ink-muted">
        No messages yet. Say hello, or start with
      </p>
      <div className="mt-3 flex w-full flex-col items-center gap-1.5">
        {STARTERS.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onSuggest(text)}
            className="max-w-full truncate rounded-full border border-sage-line/50 px-3 py-1.5 text-[12.5px] text-ink-muted transition-colors duration-fast ease-hath hover:border-sage-line hover:bg-sage-active/40 hover:text-ink"
          >
            {text}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

/** Up to two initials from the agent name ("research-bot" → "RB"). */
function monogram(name: string): string {
  const words = name
    .split(/[\s_\-.]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  if (words.length === 0) {
    return "·";
  }
  const letters =
    words.length === 1
      ? Array.from(words[0]!).slice(0, 1)
      : [Array.from(words[0]!)[0]!, Array.from(words[1]!)[0]!];
  return letters.join("").toUpperCase();
}
