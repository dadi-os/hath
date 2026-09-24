import {
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import { AnimatePresence } from "motion/react";
import type { ChatMessage } from "../../../store/chat";
import { messageKey, trackIncoming } from "../lanes";
import { MessageBubble } from "../message";
import { ToolPreview } from "../ToolPreview";

export interface ThreadViewProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
  onDismissKeyboard: () => void;
  composerPad: number;
  /** Space under a floating browser pin. Zero when the thread has no browser. */
  hostPad: number;
  settledMessages: ChatMessage[];
  queuedMessages: ChatMessage[];
  /** Open agent id for live tool-preview log polls. */
  agentId: string;
  /** Either lane busy — show tool preview or ellipses. */
  laneBusy: boolean;
  onRetry: (msg: ChatMessage) => void;
  onCancel: (seq: number) => void;
  /** Keep the thread pinned while agent typewriter content grows. */
  onRevealTick?: () => void;
  /** Centered placeholder when the thread has no messages (null while loading). */
  empty?: ReactNode;
}

/** Open thread scroll pane: settled messages, queued sends, tool preview. */
export function ThreadView({
  scrollRef,
  onScroll,
  onDismissKeyboard,
  composerPad,
  hostPad,
  settledMessages,
  queuedMessages,
  agentId,
  laneBusy,
  onRetry,
  onCancel,
  onRevealTick,
  empty = null,
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

  const isEmpty =
    settledMessages.length === 0 && queuedMessages.length === 0 && !laneBusy;

  return (
    <div className="absolute inset-0">
      {isEmpty && empty ? (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center px-8 [&>*]:pointer-events-auto"
          style={{ paddingBottom: composerPad, paddingTop: hostPad }}
        >
          {empty}
        </div>
      ) : null}
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
            {queuedMessages.map((msg) => (
              <MessageBubble
                key={messageKey(msg)}
                message={msg}
                live={liveRef.current.has(messageKey(msg))}
                onCancel={() => onCancel(msg.seq)}
              />
            ))}
          </AnimatePresence>
          <ToolPreview agentId={agentId} active={laneBusy} />
        </div>
      </div>
    </div>
  );
}
