import { motion } from "motion/react";
import { EASE, SLOW_S } from "../../../shared/lib/ux/motion";
import type { Conversation, HistoryStatus } from "../../../store/chat";
import { ActivityPulse } from "../ActivityPulse";
import { groupConversations, truncateOneLine } from "../format";

export interface ConversationListProps {
  /** Thread-agent conversations (excludes Dadi). */
  conversations: Conversation[];
  /** Highlighted thread, if any. */
  selectedAgentId: string | null;
  historyStatus: HistoryStatus;
  historyError: string | null;
  onOpenAgent: (agentId: string) => void;
  onDismissKeyboard: () => void;
  /** Pinned Talk to Dadi row at the bottom of the ChatGPT-style list. */
  dadi: {
    available: boolean;
    selected: boolean;
    preview: string | null;
    busy: boolean;
    onOpen: () => void;
  };
}

/** Conversation list pane: grouped threads, empty/error states, Talk to Dadi. */
export function ConversationList({
  conversations,
  selectedAgentId,
  historyStatus,
  historyError,
  onOpenAgent,
  onDismissKeyboard,
  dadi,
}: ConversationListProps) {
  const groups = groupConversations(conversations);
  const loading = historyStatus === "loading" && conversations.length === 0;
  const failed = historyStatus === "error" && conversations.length === 0;

  return (
    <motion.div
      key="list"
      onClick={onDismissKeyboard}
      className="absolute inset-0 flex flex-col"
      initial={{ opacity: 0, x: -28 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -28 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {failed ? (
          <div className="flex h-full flex-col items-center justify-center px-6">
            <p className="text-center text-[13px] text-ink-muted">
              Couldn&apos;t load conversations
            </p>
            <p className="mt-1.5 max-w-[16rem] text-center text-[12px] leading-relaxed text-ink-ghost">
              {historyError}
            </p>
          </div>
        ) : loading ? (
          <div className="flex h-full items-center justify-center">
            <ActivityPulse />
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6">
            <p className="text-center text-[13px] text-ink-ghost">
              No conversations
            </p>
          </div>
        ) : (
          <div className="flex flex-col pb-2">
            {groups.map((group) => (
              <div key={group.bucket} className="mt-1 first:mt-0">
                <p className="px-2.5 pb-1 pt-3 text-[11px] font-medium text-ink-ghost">
                  {group.bucket}
                </p>
                {group.items.map((conv) => {
                  const selected = conv.agent_id === selectedAgentId;
                  return (
                    <button
                      key={conv.agent_id}
                      type="button"
                      onClick={() => onOpenAgent(conv.agent_id)}
                      className={`flex w-full flex-col gap-0.5 rounded-[10px] px-2.5 py-2 text-left transition-colors duration-fast ease-hath ${
                        selected
                          ? "bg-(--chat-active)"
                          : "hover:bg-(--chat-hover)"
                      }`}
                    >
                      <span className="truncate text-[13.5px] font-medium text-ink">
                        {conv.agent_name}
                      </span>
                      <p className="truncate text-[12px] text-ink-ghost">
                        {conv.from_user ? "You: " : ""}
                        {truncateOneLine(conv.last_message, 56)}
                      </p>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-(--chat-edge) px-2 py-2">
        <button
          type="button"
          onClick={dadi.onOpen}
          disabled={!dadi.available}
          className={`flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2.5 text-left transition-colors duration-fast ease-hath disabled:opacity-50 ${
            dadi.selected
              ? "bg-(--chat-active)"
              : "hover:bg-(--chat-hover)"
          }`}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sage-fill font-gujarati text-[15px] leading-none text-sage-deep">
            દ
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-medium text-ink">
              Talk to Dadi
            </span>
            <span className="block truncate text-[12px] text-ink-ghost">
              {dadi.preview
                ? truncateOneLine(dadi.preview, 48)
                : "Route a new conversation"}
            </span>
          </span>
          {dadi.busy ? <ActivityPulse /> : null}
        </button>
      </div>
    </motion.div>
  );
}
