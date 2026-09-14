import { motion } from "motion/react";
import { useEffect } from "react";
import {
  IconDismiss,
  IconRetry,
} from "../../../shared/components/IconButton";
import { EASE, SLOW_S } from "../../../shared/lib/ux/motion";
import type { ChatMessage } from "../../../store/chat";
import { MarkdownBody } from "./MarkdownBody";
import { useRevealText } from "./useRevealText";

export interface MessageBubbleProps {
  /** Message to render (user or agent). */
  message: ChatMessage;
  /** Retry a failed user send. */
  onRetry?: () => void;
  /** Remove a failed or queued user message. */
  onCancel?: () => void;
  /** Fired as agent typewriter content grows (for stick-to-bottom). */
  onRevealTick?: () => void;
}

/** Single chat row — quiet user pill or agent markdown with typewriter reveal. */
export function MessageBubble({
  message,
  onRetry,
  onCancel,
  onRevealTick,
}: MessageBubbleProps) {
  if (message.from_user) {
    return (
      <UserBubble message={message} onRetry={onRetry} onCancel={onCancel} />
    );
  }
  return <AgentBubble message={message} onRevealTick={onRevealTick} />;
}

/** Right-aligned user pill with optional retry / cancel for failed or queued sends. */
function UserBubble({
  message,
  onRetry,
  onCancel,
}: {
  message: ChatMessage;
  onRetry?: () => void;
  onCancel?: () => void;
}) {
  const failed = Boolean(message.failed);
  const queued = Boolean(message.queued);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 14, scale: 0.97 }}
      animate={{
        opacity: message.pending && !queued && !failed ? 0.7 : 1,
        y: 0,
        scale: 1,
      }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: SLOW_S, ease: EASE }}
      className={`flex justify-end gap-1.5 ${
        queued || failed ? "items-center" : "items-end"
      }`}
    >
      {failed && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          aria-label="Retry send"
          title="Retry"
          className="inline-flex size-7 shrink-0 items-center justify-center text-[#b56b5c] transition-opacity duration-slow ease-hath hover:opacity-70"
        >
          <IconRetry />
        </button>
      ) : null}
      {(queued || failed) && onCancel ? (
        <button
          type="button"
          onClick={onCancel}
          aria-label="Remove message"
          title="Remove"
          className="inline-flex size-7 shrink-0 items-center justify-center text-ink-ghost transition-opacity duration-slow ease-hath hover:text-ink-muted"
        >
          <IconDismiss />
        </button>
      ) : null}
      <div
        className={`max-w-[min(92%,34rem)] rounded-[18px] px-3.5 py-2 text-[14px] leading-[1.55] whitespace-pre-wrap ${
          failed
            ? "border border-[#c47868]/55 bg-[#c47868]/10 text-ink"
            : queued
              ? "border border-dashed border-sage-line/50 bg-sage-fill/25 text-ink/60"
              : "bg-sage-active/80 text-ink"
        }`}
      >
        {message.content}
      </div>
    </motion.div>
  );
}

/** Left-aligned agent row with markdown and typewriter reveal. */
function AgentBubble({
  message,
  onRevealTick,
}: {
  message: ChatMessage;
  onRevealTick?: () => void;
}) {
  const { visible, done } = useRevealText(message.seq, message.content);

  useEffect(() => {
    if (!done) {
      onRevealTick?.();
    }
  }, [visible, done, onRevealTick]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: SLOW_S, ease: EASE }}
      className="max-w-[min(96%,40rem)] text-[14.5px] leading-[1.65] text-ink"
    >
      <MarkdownBody content={visible} />
      {!done ? (
        <span
          className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] bg-sage/70 align-middle"
          aria-hidden
        />
      ) : null}
    </motion.div>
  );
}
