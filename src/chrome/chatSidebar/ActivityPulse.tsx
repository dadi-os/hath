import { motion } from "motion/react";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";

/** Three-dot activity indicator for conversation hold / reasoning work. */
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
