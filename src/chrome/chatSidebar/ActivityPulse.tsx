import { motion } from "motion/react";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";

/** Three-dot activity indicator for conversation hold / reasoning work. */
export function ActivityPulse() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
      className="flex items-center gap-1 py-1"
      aria-hidden
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block size-1 rounded-full bg-sage/70"
          animate={{
            opacity: [0.2, 0.85, 0.2],
            scale: [0.85, 1.05, 0.85],
          }}
          transition={{
            duration: 1.25,
            repeat: Infinity,
            delay: i * 0.16,
            ease: EASE,
          }}
        />
      ))}
    </motion.div>
  );
}
