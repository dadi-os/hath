import { useRef, type RefObject, type UIEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EASE, SLOW_S } from "../../../shared/lib/ux/motion";
import type { ChatMessage } from "../../../store/chat";
import { ActivityPulse } from "../ActivityPulse";
import { messageKey, trackIncoming } from "../lanes";
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
  /** Keep the thread pinned while agent typewriter content grows. */
  onRevealTick?: () => void;
  /** Copy when the thread has no messages yet. */
  emptyHint?: string;
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
  onRevealTick,
  emptyHint = "Send a message",
}: ThreadViewProps) {
  const knownRef = useRef<Set<string>>(new Set());
  const liveRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);
  trackIncoming(
    knownRef.current,
    liveRef.current,
    [...settledMessages, ...queuedMessages],
    !seededRef.current,
  );
  seededRef.current = true;

  return (
    <motion.div
      key={viewKey}
      className="absolute inset-0"
      initial={{ opacity: 0, x: 28 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 28 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onClick={onDismissKeyboard}
        className="h-full overflow-y-auto overscroll-contain px-3.5 py-4"
        style={{ paddingBottom: composerPad }}
      >
        <div className="flex flex-col gap-4">
          {settledMessages.length === 0 &&
          queuedMessages.length === 0 &&
          !showHoldPulse &&
          !showWorkingPulse ? (
            <div className="flex min-h-[36vh] items-center justify-center">
              <p className="text-center text-[13px] text-ink-ghost">
                {emptyHint}
              </p>
            </div>
          ) : null}
          <AnimatePresence initial={false}>
            {settledMessages.map((msg) => (
              <MessageBubble
                key={messageKey(msg)}
                message={msg}
                live={liveRef.current.has(messageKey(msg))}
                onRetry={
                  msg.from_user ? () => onRetry(msg) : undefined
                }
                onCancel={
                  msg.failed ? () => onCancel(msg.seq) : undefined
                }
                onRevealTick={msg.from_user ? undefined : onRevealTick}
              />
            ))}
          </AnimatePresence>
          {showHoldPulse ? <ActivityPulse /> : null}
          <AnimatePresence initial={false}>
            {queuedMessages.map((msg) => (
              <MessageBubble
                key={messageKey(msg)}
                message={msg}
                live={liveRef.current.has(messageKey(msg))}
                onCancel={() => onCancel(msg.seq)}
              />
            ))}
          </AnimatePresence>
          {showWorkingPulse ? <ActivityPulse /> : null}
        </div>
      </div>
    </motion.div>
  );
}
