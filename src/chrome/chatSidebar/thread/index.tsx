import type { RefObject, UIEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EASE, SLOW_S } from "../../../shared/lib/ux/motion";
import type { ChatMessage } from "../../../store/chat";
import { ActivityPulse } from "../ActivityPulse";
import { MessageBubble } from "../message";

export interface ThreadViewProps {
  /** AnimatePresence key for thread transitions. */
  viewKey: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
  onDismissKeyboard: () => void;
  composerPad: number;
  settledMessages: ChatMessage[];
  queuedMessages: ChatMessage[];
  /**
   * Pulse before drafts = conversation held (queueing).
   * Pulse at thread end with open composer = reasoning working.
   */
  showHoldPulse: boolean;
  showWorkingPulse: boolean;
  onRetry: (msg: ChatMessage) => void;
  onCancel: (seq: number) => void;
}

/** Open thread scroll pane: settled messages, hold pulse, queued drafts, working pulse. */
export function ThreadView({
  viewKey,
  scrollRef,
  onScroll,
  onDismissKeyboard,
  composerPad,
  settledMessages,
  queuedMessages,
  showHoldPulse,
  showWorkingPulse,
  onRetry,
  onCancel,
}: ThreadViewProps) {
  return (
    <motion.div
      key={viewKey}
      ref={scrollRef}
      onScroll={onScroll}
      onClick={onDismissKeyboard}
      className="absolute inset-0 overflow-y-auto px-4 py-4"
      style={{ paddingBottom: composerPad }}
      initial={{ opacity: 0, x: 18 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -14 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <div className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {settledMessages.map((msg) => (
            <MessageBubble
              key={msg.seq}
              message={msg}
              onRetry={
                msg.from_user ? () => onRetry(msg) : undefined
              }
              onCancel={
                msg.failed ? () => onCancel(msg.seq) : undefined
              }
            />
          ))}
        </AnimatePresence>
        {showHoldPulse ? <ActivityPulse /> : null}
        <AnimatePresence initial={false}>
          {queuedMessages.map((msg) => (
            <MessageBubble
              key={msg.seq}
              message={msg}
              onCancel={() => onCancel(msg.seq)}
            />
          ))}
        </AnimatePresence>
        {showWorkingPulse ? <ActivityPulse /> : null}
      </div>
    </motion.div>
  );
}
