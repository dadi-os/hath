/** In-thread tool signature preview — polls agent logs while a lane is busy. */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { dimaag, isMeshOnline } from "../../shared/api";
import { useConnection } from "../../hooks/useConnection";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";
import { POLL_MS } from "../../shared/lib/ux/poll";
import { ActivityPulse } from "./ActivityPulse";
import { findActiveTool, formatToolSignature } from "./toolStatus";

export type ToolPreviewProps = {
  agentId: string;
  /** True while conversation and/or reasoning is occupied. */
  active: boolean;
};

/**
 * Replaces the old thinking/working row: live tool signature with a crossfade,
 * bounce dots while logs load or no tool is in flight yet, or an explicit
 * error when the log poll fails.
 */
export function ToolPreview({ agentId, active }: ToolPreviewProps) {
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);

  const logsQuery = useQuery({
    queryKey: ["agent-logs", agentId, "tool-preview"],
    queryFn: async () => {
      const { logs } = await dimaag.getAgentLogs(agentId, { limit: 48 });
      return logs;
    },
    enabled: connected && active,
    refetchInterval: active ? POLL_MS : false,
  });

  const signature = useMemo(() => {
    if (!logsQuery.data) {
      return null;
    }
    const tool = findActiveTool(logsQuery.data);
    if (!tool) {
      return null;
    }
    return formatToolSignature(tool.name, tool.input);
  }, [logsQuery.data]);

  const logError =
    logsQuery.isError
      ? logsQuery.error instanceof Error
        ? logsQuery.error.message
        : String(logsQuery.error)
      : null;

  return (
    <AnimatePresence initial={false}>
      {active ? (
        <motion.div
          key="tool-preview"
          role="status"
          aria-label={logError ?? signature ?? "Agent is busy"}
          aria-live="polite"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: SLOW_S, ease: EASE }}
          className="min-h-[1.5rem] py-1 pl-0.5"
        >
          <AnimatePresence mode="wait" initial={false}>
            {logError ? (
              <motion.p
                key="log-error"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.28, ease: EASE }}
                className="truncate text-[12px] leading-snug text-error"
              >
                {logError}
              </motion.p>
            ) : signature ? (
              <motion.p
                key={signature}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.28, ease: EASE }}
                className="truncate font-mono text-[12px] leading-snug text-ink-muted"
              >
                {signature}
              </motion.p>
            ) : (
              <motion.div
                key="ellipsis"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: EASE }}
              >
                <ActivityPulse />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
