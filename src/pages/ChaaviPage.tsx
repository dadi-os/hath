import { motion } from "motion/react";
import { PageHeader } from "../chrome/PageHeader";
import { PasswordManager } from "../features/chaavi";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";

/**
 * Chaavi password manager page — login search, reveal/copy, create, edit, delete.
 * Vaultwarden is the store; Chaavi is the adapter; Bitwarden extension handles autofill.
 */
export function ChaaviPage() {
  return (
    <motion.div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <PageHeader
        title="CHAAVI"
        hint="Your logins — reveal to copy, create and edit here; browser autofill uses the Bitwarden extension."
      />
      <div className="min-h-0 flex-1 px-1 pb-1">
        <PasswordManager />
      </div>
    </motion.div>
  );
}
