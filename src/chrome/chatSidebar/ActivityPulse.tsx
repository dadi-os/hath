/** Chat activity indicators — hold (queue) vs thinking (reasoning). */

import { motion } from "motion/react";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";

/** Three-dot pulse for list loading / compact busy chrome. */
export function ActivityPulse() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -2 }}
      transition={{ duration: SLOW_S, ease: EASE }}
      className="flex items-center gap-1.5 py-1.5 pl-0.5"
      aria-hidden
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block size-1.5 rounded-full bg-sage/55"
          animate={{
            opacity: [0.25, 0.95, 0.25],
            y: [0, -2, 0],
          }}
          transition={{
            duration: 1.1,
            repeat: Infinity,
            delay: i * 0.14,
            ease: EASE,
          }}
        />
      ))}
    </motion.div>
  );
}

/**
 * Conversation lane is held — outbound messages queue. Quiet, paused breath;
 * distinct from the more kinetic thinking indicator.
 */
export function HoldIndicator() {
  return (
    <motion.div
      role="status"
      aria-label="Holding for agent"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
      className="flex items-center gap-2.5 py-1 pl-0.5"
    >
      <span className="relative flex h-3.5 w-3.5 items-center justify-center gap-[3px]">
        <motion.span
          className="block h-2.5 w-[2.5px] rounded-full bg-sage-text/70"
          animate={{ opacity: [0.35, 0.85, 0.35], scaleY: [0.85, 1, 0.85] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: EASE }}
        />
        <motion.span
          className="block h-2.5 w-[2.5px] rounded-full bg-sage-text/70"
          animate={{ opacity: [0.35, 0.85, 0.35], scaleY: [0.85, 1, 0.85] }}
          transition={{
            duration: 2.4,
            repeat: Infinity,
            ease: EASE,
            delay: 0.2,
          }}
        />
      </span>
      <span className="text-[11px] font-medium tracking-[0.14em] text-ink-ghost uppercase">
        Holding
      </span>
      <motion.span
        className="h-px flex-1 max-w-[4.5rem] origin-left bg-sage-line/70"
        animate={{ opacity: [0.25, 0.55, 0.25], scaleX: [0.7, 1, 0.7] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: EASE }}
      />
    </motion.div>
  );
}

/**
 * Reasoning lane is working — agent is thinking. Brighter, quicker pulse than
 * hold so the two states read apart at a glance.
 */
export function ThinkingIndicator() {
  return (
    <motion.div
      role="status"
      aria-label="Agent is thinking"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
      className="flex items-center gap-2.5 py-1.5 pl-0.5"
    >
      <span className="relative flex size-3.5 items-center justify-center">
        <motion.span
          className="absolute inset-0 rounded-full bg-sage/25"
          animate={{ scale: [1, 1.55, 1], opacity: [0.45, 0, 0.45] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: EASE }}
        />
        <motion.span
          className="relative block size-1.5 rounded-full bg-sage"
          animate={{ opacity: [0.55, 1, 0.55] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: EASE }}
        />
      </span>
      <span className="text-[11px] font-medium tracking-[0.14em] text-sage-text uppercase">
        Thinking
      </span>
      <span className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="block size-1 rounded-full bg-sage/70"
            animate={{ opacity: [0.2, 1, 0.2], y: [0, -2.5, 0] }}
            transition={{
              duration: 0.9,
              repeat: Infinity,
              delay: i * 0.12,
              ease: EASE,
            }}
          />
        ))}
      </span>
    </motion.div>
  );
}
