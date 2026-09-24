import { useEffect, useRef, type RefObject, type UIEvent } from "react";
import { AnimatePresence } from "motion/react";
import type { AgentRecord } from "../../../shared/api/types";
import { messageKey, type ChatMessage } from "../../../store/chat";
import { trackIncoming } from "../lanes";
import { MessageBubble } from "../message";
import { ToolPreview } from "../ToolPreview";
import { ThreadEmpty } from "./ThreadEmpty";

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
  /** Display name of the open agent, for the empty state. */
  agentName: string;
  /** Open agent's record once loaded; adds spawn time to the empty state. */
  agent?: AgentRecord;
  /**
   * History fetch outcome for this thread: null while loading, then either
   * settled (`error` null) or failed with the server message.
   */
  load: { error: string | null } | null;
  /** Fill the composer with an empty-state starter prompt. */
  onSuggest: (text: string) => void;
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
  agentName,
  agent,
  load,
  onSuggest,
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
      {isEmpty && load ? (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center px-8 [&>*]:pointer-events-auto"
          style={{ paddingBottom: composerPad, paddingTop: hostPad }}
        >
          {load.error ? (
            <p role="alert" className="max-w-[16rem] text-center text-[13px] leading-relaxed text-error">
              Couldn't load messages. {load.error}
            </p>
          ) : (
            <ThreadEmpty name={agentName} agent={agent} onSuggest={onSuggest} />
          )}
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
