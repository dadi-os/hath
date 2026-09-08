import { motion } from "motion/react";
import {
  IconDismiss,
  IconRetry,
} from "../../../shared/components/IconButton";
import { EASE, SLOW_S } from "../../../shared/lib/ux/motion";
import type { ChatMessage } from "../../../store/chat";

export interface MessageBubbleProps {
  /** Message to render (user or agent). */
  message: ChatMessage;
  /** Retry a failed user send. */
  onRetry?: () => void;
  /** Remove a failed or queued user message. */
  onCancel?: () => void;
}

/** Single chat bubble — user (right, with retry/cancel) or agent (left). */
export function MessageBubble({
  message,
  onRetry,
  onCancel,
}: MessageBubbleProps) {
  if (message.from_user) {
    const failed = Boolean(message.failed);
    const queued = Boolean(message.queued);
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
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
          className={`max-w-[90%] rounded-[var(--radius)] px-3 py-1.5 text-[13px] leading-relaxed whitespace-pre-wrap ${
            failed
              ? "border border-[#c47868] bg-[#c47868]/12 text-ink"
              : queued
                ? "border border-dashed border-sage-line/55 bg-sage-fill/20 text-ink/55"
                : "bg-sage-active text-ink"
          }`}
          style={{
            opacity: message.pending && !queued && !failed ? 0.55 : 1,
          }}
        >
          {message.content}
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: SLOW_S, ease: EASE }}
      className="max-w-[95%] text-[13px] leading-[1.65] text-ink whitespace-pre-wrap"
    >
      {message.content}
    </motion.div>
  );
}
