import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { dimaag } from "../api";
import { useConnection } from "../hooks/useConnection";
import {
  AGENTS_QUERY_KEY,
  ROOT_AGENT_QUERY_KEY,
} from "../hooks/useEvents";
import {
  addOptimistic,
  clearLiveChat,
  enqueuePendingNewChat,
  getChatState,
  listQueuedPendingNewChat,
  listQueuedThread,
  markFailed,
  markPending,
  markPendingNewChatFailed,
  markPendingNewChatMessageFailed,
  markPendingNewChatMessagePending,
  openAgent,
  openList,
  openProvisional,
  removeMessage,
  removePendingNewChatMessage,
  subscribeChat,
  type ChatMessage,
} from "../store/chat";
import { getRunning, subscribeRunning } from "../store/running";
import {
  IconBack,
  IconButton,
  IconDismiss,
  IconRetry,
  IconSend,
} from "../shared/IconButton";
import { EASE, SLOW_S } from "../shared/motion";

type ChatSidebarProps = {
  /** Bumps when chat opens; scrolls the thread to the bottom. */
  sessionKey: number;
  className?: string;
};

const NEAR_BOTTOM_PX = 80;
const TEXTAREA_MAX_PX = 88;
const NEW_CHAT_TIMEOUT_MS = 90_000;
const COMPOSER_PAD = 72;

function truncateOneLine(text: string, max = 72): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) {
    return one;
  }
  return `${one.slice(0, max - 1)}…`;
}

function formatRelative(iso: string, now = Date.now()): string {
  const diffSec = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const abs = Math.abs(diffSec);
  if (abs < 60) {
    return rtf.format(diffSec, "second");
  }
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) {
    return rtf.format(diffMin, "minute");
  }
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) {
    return rtf.format(diffHour, "hour");
  }
  return rtf.format(Math.round(diffHour / 24), "day");
}

/**
 * Conversation list + thread views. Messages arrive only via SSE (and local
 * optimistic/queued rows). No history fetch — Dimaag's transcript is in-memory
 * and dies with the process; agent_logs are not a chat store.
 */
export function ChatSidebar({ sessionKey, className }: ChatSidebarProps) {
  const { state: connection } = useConnection();
  const connected = connection === "connected";
  const chat = useSyncExternalStore(subscribeChat, getChatState, getChatState);
  const running = useSyncExternalStore(
    subscribeRunning,
    getRunning,
    getRunning,
  );

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const newChatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rootQuery = useQuery({
    queryKey: ROOT_AGENT_QUERY_KEY,
    queryFn: () => dimaag.getRootAgent(),
    enabled: connected,
    staleTime: Infinity,
  });
  const rootId = rootQuery.data?.id;

  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: async () => {
      const { agents } = await dimaag.listAgents();
      return agents;
    },
    enabled: connected,
  });

  useEffect(() => {
    if (connection === "disconnected") {
      clearLiveChat();
    }
  }, [connection]);

  const openAgentId =
    chat.open.kind === "agent" ? chat.open.agentId : null;
  const viewingProvisional = chat.open.kind === "provisional";
  const viewingThread = openAgentId !== null || viewingProvisional;
  const openConversation = chat.conversations.find(
    (c) => c.agent_id === openAgentId,
  );
  const threadMessages = openAgentId
    ? (chat.threads[openAgentId] ?? [])
    : [];
  const provisionalMessages: ChatMessage[] =
    viewingProvisional && chat.pendingNewChat
      ? chat.pendingNewChat.messages.map((m) => ({
          seq: m.seq,
          from_user: true,
          content: m.content,
          at: m.at,
          pending: m.pending,
          failed: m.failed,
          queued: m.queued,
        }))
      : [];

  const awaitingRoute =
    !!chat.pendingNewChat &&
    chat.pendingNewChat.messages.some((m) => !m.failed && !m.queued);
  const talkTargetName = openAgentId
    ? (openConversation?.agent_name ??
      agentsQuery.data?.find((a) => a.id === openAgentId)?.name ??
      "agent")
    : (rootQuery.data?.name ?? "Dadi");

  // Dual-lane: only conversation occupancy blocks/queues. Reasoning-busy still allows send.
  const laneAgentId =
    viewingProvisional && awaitingRoute
      ? (rootId ?? null)
      : openAgentId;
  const conversationBusy =
    awaitingRoute ||
    (laneAgentId !== null &&
      running[laneAgentId]?.conversation === true) ||
    (!viewingThread &&
      !!rootId &&
      running[rootId]?.conversation === true);
  const reasoningBusy =
    laneAgentId !== null
      ? running[laneAgentId]?.reasoning === true
      : !viewingThread && !!rootId
        ? running[rootId]?.reasoning === true
        : false;

  const scrollToBottom = useEffectEvent((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior });
  });

  useEffect(() => {
    stickToBottomRef.current = true;
    scrollToBottom("auto");
  }, [sessionKey, chat.open]);

  useEffect(() => {
    if (viewingThread && stickToBottomRef.current) {
      scrollToBottom("smooth");
    }
  }, [
    threadMessages,
    provisionalMessages,
    conversationBusy,
    viewingThread,
  ]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) {
      return;
    }
    const sync = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKeyboardInset(inset);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_PX)}px`;
  }, [draft, chat.open]);

  useEffect(() => {
    return () => {
      if (newChatTimerRef.current !== null) {
        clearTimeout(newChatTimerRef.current);
      }
    };
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance <= NEAR_BOTTOM_PX;
  };

  const dismissKeyboard = () => {
    textareaRef.current?.blur();
  };

  const clearNewChatTimer = () => {
    if (newChatTimerRef.current !== null) {
      clearTimeout(newChatTimerRef.current);
      newChatTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (chat.pendingNewChat === null) {
      clearNewChatTimer();
    }
  }, [chat.pendingNewChat]);

  const sendNewChat = async (opts?: {
    content?: string;
    existingSeq?: number;
    force?: boolean;
  }) => {
    const trimmed = (opts?.content ?? draft).trim();
    if (!trimmed || !connected || !rootId) {
      return;
    }

    const queueLocally = conversationBusy && !opts?.force;
    if (opts?.existingSeq === undefined && opts?.content === undefined) {
      setDraft("");
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        const el = textareaRef.current;
        if (el) {
          el.style.height = "auto";
        }
      });
    }

    let tempSeq: number;
    if (opts?.existingSeq !== undefined) {
      markPendingNewChatMessagePending(opts.existingSeq);
      tempSeq = opts.existingSeq;
    } else {
      tempSeq = enqueuePendingNewChat(trimmed, { queued: queueLocally });
    }

    if (queueLocally) {
      stickToBottomRef.current = true;
      return;
    }

    clearNewChatTimer();
    newChatTimerRef.current = setTimeout(() => {
      markPendingNewChatFailed();
      newChatTimerRef.current = null;
    }, NEW_CHAT_TIMEOUT_MS);

    stickToBottomRef.current = true;

    try {
      await dimaag.postMessage({
        to_agent_id: rootId,
        content: trimmed,
      });
    } catch {
      markPendingNewChatMessageFailed(tempSeq);
      if (
        getChatState().pendingNewChat?.messages.every(
          (m) => m.failed || m.queued,
        )
      ) {
        clearNewChatTimer();
      }
    }
  };

  const sendThread = async (content: string, existingTempSeq?: number) => {
    const trimmed = content.trim();
    if (!trimmed || !connected || !openAgentId) {
      return;
    }

    const conversationHeld =
      running[openAgentId]?.conversation === true;
    const queueLocally =
      existingTempSeq === undefined && conversationHeld;

    let tempSeq: number;
    if (existingTempSeq !== undefined) {
      markPending(openAgentId, existingTempSeq);
      tempSeq = existingTempSeq;
    } else {
      tempSeq = addOptimistic(openAgentId, trimmed, { queued: queueLocally });
      setDraft("");
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        const el = textareaRef.current;
        if (el) {
          el.style.height = "auto";
        }
      });
    }

    stickToBottomRef.current = true;
    scrollToBottom("smooth");

    if (queueLocally) {
      return;
    }

    try {
      await dimaag.postMessage({
        to_agent_id: openAgentId,
        content: trimmed,
      });
    } catch {
      markFailed(openAgentId, tempSeq);
    }
  };

  const flushQueues = useEffectEvent(async () => {
    if (!connected) {
      return;
    }

    // Provisional → root
    if (rootId) {
      const queued = listQueuedPendingNewChat();
      for (const msg of queued) {
        await sendNewChat({
          content: msg.content,
          existingSeq: msg.seq,
          force: true,
        });
      }
    }

    // Bound thread
    if (openAgentId) {
      const queued = listQueuedThread(openAgentId);
      for (const msg of queued) {
        await sendThread(msg.content, msg.seq);
      }
    }
  });

  const wasBusyRef = useRef(false);
  useEffect(() => {
    if (conversationBusy) {
      wasBusyRef.current = true;
      return;
    }
    if (!wasBusyRef.current) {
      return;
    }
    wasBusyRef.current = false;
    void flushQueues();
  }, [conversationBusy]);

  const retryNewChat = async (seq: number) => {
    const msg = chat.pendingNewChat?.messages.find((m) => m.seq === seq);
    if (!msg || !connected || !rootId) {
      return;
    }
    await sendNewChat({ content: msg.content, existingSeq: seq, force: true });
  };

  const cancelQueued = (seq: number) => {
    if (viewingProvisional) {
      removePendingNewChatMessage(seq);
      return;
    }
    if (openAgentId) {
      removeMessage(openAgentId, seq);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (openAgentId) {
      void sendThread(draft);
      return;
    }
    void sendNewChat();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit(e as unknown as FormEvent);
    }
  };

  const backToList = () => {
    openList();
    setDraft("");
  };

  const headerTitle = viewingProvisional
    ? "NEW CHAT"
    : openAgentId
      ? (openConversation?.agent_name ?? "CHAT").toUpperCase()
      : "CHAT";

  const viewKey =
    chat.open.kind === "list"
      ? "list"
      : chat.open.kind === "provisional"
        ? "provisional"
        : chat.open.agentId;

  const placeholder = conversationBusy
    ? `Held for ${talkTargetName}…`
    : `Talk to ${talkTargetName}`;

  const canSubmit = connected && draft.trim().length > 0;

  const settledMessages = (
    viewingProvisional ? provisionalMessages : threadMessages
  ).filter((msg) => !msg.queued);
  const queuedMessages = (
    viewingProvisional ? provisionalMessages : threadMessages
  ).filter((msg) => msg.queued);

  // Placement encodes lane state: pulse before drafts = conversation held;
  // pulse at thread end with open composer = reasoning working in the background.
  const showHoldPulse = conversationBusy || queuedMessages.length > 0;
  const showWorkingPulse =
    reasoningBusy && !conversationBusy && queuedMessages.length === 0;

  return (
    <aside
      className={`widget-surface relative flex h-full min-h-0 flex-col overflow-hidden ${className ?? ""}`}
      data-agent-id={openAgentId ?? rootId ?? undefined}
      data-session-key={sessionKey}
      style={{ paddingBottom: keyboardInset > 0 ? keyboardInset : undefined }}
    >
      <div className="relative z-10 border-b border-dashed border-sage-line px-4 py-3">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={viewingThread ? "thread-head" : "list-head"}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: SLOW_S, ease: EASE }}
            className="flex min-w-0 flex-1 items-center gap-2.5"
          >
            {viewingThread ? (
              <IconButton
                label="Back to conversations"
                size="sm"
                onClick={backToList}
              >
                <IconBack />
              </IconButton>
            ) : null}
            <motion.span
              className="truncate text-[11px] font-medium tracking-[2.5px] text-sage-deep"
              animate={
                reasoningBusy || conversationBusy
                  ? { opacity: [0.55, 1, 0.55] }
                  : { opacity: 1 }
              }
              transition={
                reasoningBusy || conversationBusy
                  ? { duration: 2.2, repeat: Infinity, ease: EASE }
                  : { duration: SLOW_S, ease: EASE }
              }
            >
              {headerTitle}
            </motion.span>
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          {viewingThread ? (
            <motion.div
              key={viewKey}
              ref={scrollRef}
              onScroll={onScroll}
              onClick={dismissKeyboard}
              className="absolute inset-0 overflow-y-auto px-4 py-4"
              style={{ paddingBottom: COMPOSER_PAD }}
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
                        openAgentId
                          ? () => void sendThread(msg.content, msg.seq)
                          : viewingProvisional
                            ? () => void retryNewChat(msg.seq)
                            : undefined
                      }
                      onCancel={
                        msg.failed
                          ? () => cancelQueued(msg.seq)
                          : undefined
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
                      onCancel={() => cancelQueued(msg.seq)}
                    />
                  ))}
                </AnimatePresence>
                {showWorkingPulse ? <ActivityPulse /> : null}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="list"
              onClick={dismissKeyboard}
              className="absolute inset-0 overflow-y-auto px-2 py-2"
              style={{ paddingBottom: COMPOSER_PAD }}
              initial={{ opacity: 0, x: -18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 14 }}
              transition={{ duration: SLOW_S, ease: EASE }}
            >
              {chat.pendingNewChat ? (
                <motion.button
                  type="button"
                  layout
                  onClick={() => openProvisional()}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: SLOW_S, ease: EASE }}
                  className="mb-1 flex w-full flex-col gap-0.5 rounded-[var(--radius)] px-3 py-2.5 text-left transition-colors duration-slow ease-hath hover:bg-sage-active/40"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] text-ink">New chat</span>
                    <span className="shrink-0 text-[11px] text-ink-ghost">
                      {formatRelative(
                        chat.pendingNewChat.messages[
                          chat.pendingNewChat.messages.length - 1
                        ]!.at,
                      )}
                    </span>
                  </div>
                  <p
                    className="truncate text-[12px] text-ink-ghost"
                    style={{
                      opacity: chat.pendingNewChat.messages.every((m) => m.failed)
                        ? 0.7
                        : 1,
                    }}
                  >
                    {truncateOneLine(
                      chat.pendingNewChat.messages[
                        chat.pendingNewChat.messages.length - 1
                      ]!.content,
                    )}
                  </p>
                  {awaitingRoute ||
                  chat.pendingNewChat.messages.some((m) => m.queued) ? (
                    <div className="mt-1.5">
                      <ActivityPulse />
                    </div>
                  ) : (
                    <span className="mt-1 text-[11px] text-sage-text">
                      No reply yet
                    </span>
                  )}
                </motion.button>
              ) : null}

              {chat.conversations.length === 0 && !chat.pendingNewChat ? (
                <p className="px-3 py-6 text-[13px] text-ink-ghost">
                  No conversations yet
                </p>
              ) : (
                <div className="flex flex-col">
                  {chat.conversations.map((conv, i) => (
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
                      onClick={() => openAgent(conv.agent_id)}
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
          )}
        </AnimatePresence>

        <FloatingComposer
          connected={connected}
          draft={draft}
          setDraft={setDraft}
          placeholder={placeholder}
          canSubmit={canSubmit}
          holdMode={conversationBusy}
          workingMode={reasoningBusy && !conversationBusy}
          textareaRef={textareaRef}
          onSubmit={onSubmit}
          onKeyDown={onKeyDown}
        />
      </div>
    </aside>
  );
}

function ActivityPulse() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
      className="flex items-center gap-1 py-1"
      aria-hidden
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block size-1 rounded-full bg-sage/70"
          animate={{
            opacity: [0.2, 0.85, 0.2],
            scale: [0.85, 1.05, 0.85],
          }}
          transition={{
            duration: 1.25,
            repeat: Infinity,
            delay: i * 0.16,
            ease: EASE,
          }}
        />
      ))}
    </motion.div>
  );
}

function FloatingComposer({
  connected,
  draft,
  setDraft,
  placeholder,
  canSubmit,
  holdMode,
  workingMode,
  textareaRef,
  onSubmit,
  onKeyDown,
}: {
  connected: boolean;
  draft: string;
  setDraft: (v: string) => void;
  placeholder: string;
  canSubmit: boolean;
  /** Conversation lane held — sends go to the local draft queue. */
  holdMode: boolean;
  /** Reasoning working; conversation free — send is live. */
  workingMode: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onSubmit: (e: FormEvent) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <motion.div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3"
      style={{
        paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))",
      }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      {connected ? (
        <form
          onSubmit={onSubmit}
          className={`pointer-events-auto flex items-end gap-1.5 rounded-[var(--radius)] border border-dashed px-2 py-1.5 shadow-[var(--shadow)] backdrop-blur-md transition-[border-color,background-color] duration-slow ease-hath ${
            holdMode
              ? "border-sage-line/70 bg-sage-fill/35"
              : workingMode
                ? "border-sage/50 bg-bone/92"
                : "border-sage-line bg-bone/92"
          }`}
        >
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={placeholder}
            className={`block max-h-[88px] min-h-[32px] w-full flex-1 resize-none overflow-y-auto bg-transparent px-1.5 py-1.5 text-[13px] leading-snug outline-none placeholder:text-ink-ghost ${
              holdMode ? "text-ink/70" : "text-ink"
            }`}
            style={{ maxHeight: TEXTAREA_MAX_PX }}
          />
          <IconButton
            type="submit"
            label={holdMode ? "Queue message" : "Send"}
            disabled={!canSubmit}
            size="lg"
            className={`mb-px border-sage-line bg-sage-fill ${
              workingMode && !holdMode ? "shadow-[0_0_0_1px_rgba(143,163,130,0.35)]" : ""
            }`}
          >
            <IconSend />
          </IconButton>
        </form>
      ) : (
        <div className="pointer-events-auto rounded-[var(--radius)] border border-dashed border-sage-line bg-bone/92 px-3 py-2 text-[13px] text-ink-ghost shadow-[var(--shadow)] backdrop-blur-md">
          Connect to message Dadi
        </div>
      )}
    </motion.div>
  );
}

function MessageBubble({
  message,
  onRetry,
  onCancel,
}: {
  message: ChatMessage;
  onRetry?: () => void;
  onCancel?: () => void;
}) {
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
