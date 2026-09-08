import { motion } from "motion/react";
import { PageHeader } from "../chrome/PageHeader";
import { LogExplorer } from "../features/logs/LogExplorer";
import { ModuleSettings } from "../features/system/ModuleSettings";
import { ProvisionDevice } from "../features/system/ProvisionDevice";
import { SystemMap } from "../features/system/SystemMap";
import { EASE, SLOW_S } from "../shared/motion";

/**
 * Split system view: health + settings on one side, log explorer on the other.
 */
export function SystemPage() {
  return (
    <motion.div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <PageHeader
        title="SYSTEM"
        hint="Reachability · config · logs"
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 px-1 pb-1 lg:grid-cols-2 lg:gap-5">
        <section className="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden rounded-[var(--radius)] border border-dashed border-sage-line bg-bone/40 px-3 py-3">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <span className="mb-3 shrink-0 text-[11px] font-medium tracking-[2px] text-sage-deep">
              DADI
            </span>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
              <SystemMap mode="full" />
            </div>
          </div>
          <div className="flex max-h-[40%] min-h-[180px] shrink-0 flex-col overflow-hidden border-t border-dashed border-sage-line pt-3">
            <span className="mb-3 shrink-0 text-[11px] font-medium tracking-[2px] text-sage-deep">
              MODULES
            </span>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ModuleSettings />
            </div>
          </div>
          <div className="flex max-h-[45%] min-h-[200px] shrink-0 flex-col overflow-hidden border-t border-dashed border-sage-line pt-3">
            <span className="mb-3 shrink-0 text-[11px] font-medium tracking-[2px] text-sage-deep">
              DEVICES
            </span>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ProvisionDevice />
            </div>
          </div>
        </section>

        <section className="flex min-h-[min(420px,48vh)] min-w-0 flex-col overflow-hidden rounded-[var(--radius)] border border-dashed border-sage-line bg-bone/40 px-3 py-3 lg:min-h-0">
          <span className="mb-3 shrink-0 text-[11px] font-medium tracking-[2px] text-sage-deep">
            LOGS
          </span>
          <div className="min-h-0 min-w-0 flex-1">
            <LogExplorer />
          </div>
        </section>
      </div>
    </motion.div>
  );
}
