import { motion } from "motion/react";
import { EASE, SLOW_S } from "../../../shared/lib/ux/motion";
import type { Conversation } from "../../../store/chat";
import { ActivityPulse } from "../ActivityPulse";
import { formatRelative, truncateOneLine } from "../format";

export interface ConversationListProps {
  /** Conversations with the user (excludes root). */
  conversations: Conversation[];
  /** Provisional new-chat row while awaiting route. */
  pendingNewChat: {
    messages: Array<{
      at: string;
      content: string;
      failed?: boolean;
      queued?: boolean;
    }>;
  } | null;
  /** True while root is still routing the provisional chat. */
  awaitingRoute: boolean;
  onOpenProvisional: () => void;
  onOpenAgent: (agentId: string) => void;
  onDismissKeyboard: () => void;
  /** Bottom padding so content clears the floating composer. */
  composerPad: number;
}

/** Conversation list pane: provisional row, empty state, and agent threads. */
export function ConversationList({
  conversations,
  pendingNewChat,
  awaitingRoute,
  onOpenProvisional,
  onOpenAgent,
  onDismissKeyboard,
  composerPad,
}: ConversationListProps) {
  return (
    <motion.div
      key="list"
      onClick={onDismissKeyboard}
      className="absolute inset-0 overflow-y-auto px-2 py-2"
      style={{ paddingBottom: composerPad }}
      initial={{ opacity: 0, x: -18 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 14 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      {pendingNewChat ? (
        <motion.button
          type="button"
          layout
          onClick={() => onOpenProvisional()}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: SLOW_S, ease: EASE }}
          className="mb-1 flex w-full flex-col gap-0.5 rounded-[var(--radius)] px-3 py-2.5 text-left transition-colors duration-slow ease-hath hover:bg-sage-active/40"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] text-ink">New chat</span>
            <span className="shrink-0 text-[11px] text-ink-ghost">
              {formatRelative(
                pendingNewChat.messages[pendingNewChat.messages.length - 1]!.at,
              )}
            </span>
          </div>
          <p
            className="truncate text-[12px] text-ink-ghost"
            style={{
              opacity: pendingNewChat.messages.every((m) => m.failed) ? 0.7 : 1,
            }}
          >
            {truncateOneLine(
              pendingNewChat.messages[pendingNewChat.messages.length - 1]!
                .content,
            )}
          </p>
          {awaitingRoute || pendingNewChat.messages.some((m) => m.queued) ? (
            <div className="mt-1.5">
              <ActivityPulse />
            </div>
          ) : (
            <span className="mt-1 text-[11px] text-sage-text">No reply yet</span>
          )}
        </motion.button>
      ) : null}

      {conversations.length === 0 && !pendingNewChat ? (
        <p className="px-3 py-6 text-[13px] text-ink-ghost">
          No conversations yet
        </p>
      ) : (
        <div className="flex flex-col">
          {conversations.map((conv, i) => (
            <motion.button
              key={conv.agent_id}
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: SLOW_S,
                ease: EASE,
                delay: Math.min(i * 0.04, 0.24),
              }}
              onClick={() => onOpenAgent(conv.agent_id)}
              className="flex w-full flex-col gap-0.5 rounded-[var(--radius)] px-3 py-2.5 text-left transition-colors duration-slow ease-hath hover:bg-sage-active/40"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] text-ink">
                  {conv.agent_name}
                </span>
                <span className="shrink-0 text-[11px] text-ink-ghost">
                  {formatRelative(conv.last_at)}
                </span>
              </div>
              <p className="truncate text-[12px] text-ink-ghost">
                {conv.from_user ? "You: " : ""}
                {truncateOneLine(conv.last_message)}
              </p>
            </motion.button>
          ))}
        </div>
      )}
    </motion.div>
  );
}
