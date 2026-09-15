import { motion } from "motion/react";
import { PageHeader } from "../chrome/PageHeader";
import { GharRoster } from "../features/ghar/GharRoster";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";

/** Full Ghar page — rooms and Matter devices. */
export function GharPage() {
  return (
    <motion.div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <PageHeader title="GHAR" hint="Rooms and Matter devices" />
      <div className="min-h-0 flex-1 px-1 pb-1">
        <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius)] border border-rule bg-bone/40 px-3 py-3">
          <GharRoster mode="full" />
        </section>
      </div>
    </motion.div>
  );
}
