import { useEffect, useRef, type RefObject, type UIEvent } from "react";
import { AnimatePresence } from "motion/react";
import type { ChatMessage } from "../../../store/chat";
import { HoldIndicator, ThinkingIndicator } from "../ActivityPulse";
import { messageKey, trackIncoming } from "../lanes";
import { MessageBubble } from "../message";

export interface ThreadViewProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
  onDismissKeyboard: () => void;
  composerPad: number;
  /** Space under a floating browser pin. Zero when the thread has no browser. */
  hostPad: number;
  settledMessages: ChatMessage[];
  queuedMessages: ChatMessage[];
  /**
   * Hold indicator before drafts = conversation lane busy (queueing).
   * Thinking indicator at thread end = reasoning working.
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

/** Open thread scroll pane: settled messages, hold/thinking, queued drafts. */
export function ThreadView({
  scrollRef,
  onScroll,
  onDismissKeyboard,
  composerPad,
  hostPad,
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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  return (
    <div className="absolute inset-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onClick={onDismissKeyboard}
        className="h-full overflow-y-auto overscroll-contain px-3.5 py-4"
        style={{
          paddingBottom: composerPad,
          paddingTop: hostPad > 0 ? hostPad : undefined,
        }}
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
          <AnimatePresence initial={false}>
            {showHoldPulse ? <HoldIndicator key="hold" /> : null}
          </AnimatePresence>
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
          <AnimatePresence initial={false}>
            {showWorkingPulse ? <ThinkingIndicator key="thinking" /> : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
