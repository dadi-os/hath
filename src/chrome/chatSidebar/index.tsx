import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { dimaag } from "../../shared/api";
import { useConnection } from "../../hooks/useConnection";
import {
  AGENTS_QUERY_KEY,
  ROOT_AGENT_QUERY_KEY,
} from "../../hooks/useEvents";
import {
  addOptimistic,
  clearLiveChat,
  enqueuePendingNewChat,
  formatOutboundContent,
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
  resolveOptimistic,
  subscribeChat,
  type ChatMessage,
  type MessageAttachment,
} from "../../store/chat";
import { getRunning, subscribeRunning } from "../../store/running";
import {
  filesToDraftAttachments,
  MAX_ATTACHMENTS,
  revokeDraftPreviews,
  toMessageAttachments,
  type DraftAttachment,
} from "../../shared/lib/content/attachments";
import { IconBack, IconButton, IconNewChat } from "../../shared/components/IconButton";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";
import { POLL_MS } from "../../shared/lib/ux/poll";
import { logLine } from "../../shared/lib/platform/log";
import { FloatingComposer } from "./composer";
import {
  COMPOSER_PAD,
  COMPOSER_PAD_WITH_ATTACH,
  NEAR_BOTTOM_PX,
  NEW_CHAT_TIMEOUT_MS,
  TEXTAREA_MAX_PX,
} from "./constants";
import { pendingToChatMessages, partitionByQueued } from "./lanes";
import { ConversationList } from "./list";
import { ThreadView } from "./thread";

export interface ChatSidebarProps {
  /** Bumps when chat opens; scrolls the thread to the bottom. */
  sessionKey: number;
  className?: string;
  /**
   * `rail` — desktop widget glass panel (list ↔ thread).
   * `mobile` — ChatGPT-style: main thread + optional list drawer controlled outside.
   */
  variant?: "rail" | "mobile";
  /** Mobile: whether the conversation drawer is open. */
  drawerOpen?: boolean;
  /** Mobile: close the conversation drawer. */
  onDrawerClose?: () => void;
  /** Mobile: open the conversation drawer (e.g. from empty-state control). */
  onDrawerOpen?: () => void;
}

/**
 * Conversation list + thread views. Messages arrive only via SSE (and local
 * optimistic/queued rows). No history fetch — Dimaag's transcript is in-memory
 * and dies with the process; agent_logs are not a chat store.
 */
export function ChatSidebar({
  sessionKey,
  className,
  variant = "rail",
  drawerOpen = false,
  onDrawerClose,
  onDrawerOpen,
}: ChatSidebarProps) {
  const { state: connection } = useConnection();
  const connected = connection === "connected";
  const chat = useSyncExternalStore(subscribeChat, getChatState, getChatState);
  const running = useSyncExternalStore(
    subscribeRunning,
    getRunning,
    getRunning,
  );

  const [draft, setDraft] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>(
    [],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
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
    refetchInterval: POLL_MS,
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
      ? pendingToChatMessages(chat.pendingNewChat.messages)
      : [];

  const awaitingRoute =
    !!chat.pendingNewChat &&
    chat.pendingNewChat.messages.some((m) => !m.failed && !m.queued);
  const talkTargetName = openAgentId
    ? (openConversation?.agent_name ??
      agentsQuery.data?.find((a) => a.id === openAgentId)?.name ??
      "agent")
    : (rootQuery.data?.name ?? "Dadi");

  /** Dual-lane: only conversation occupancy blocks/queues; reasoning-busy still allows send. */
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

  const draftAttachmentsRef = useRef(draftAttachments);
  draftAttachmentsRef.current = draftAttachments;
  useEffect(() => {
    return () => {
      revokeDraftPreviews(draftAttachmentsRef.current);
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

  const clearDraftAttachments = () => {
    setDraftAttachments((prev) => {
      revokeDraftPreviews(prev);
      return [];
    });
  };

  const sendNewChat = async (opts?: {
    content?: string;
    attachments?: MessageAttachment[];
    existingSeq?: number;
    force?: boolean;
  }) => {
    const attachments = opts?.attachments;
    const trimmed = (opts?.content ?? draft).trim();
    const display = formatOutboundContent(trimmed, attachments);
    if (
      (!trimmed && (!attachments || attachments.length === 0)) ||
      !connected ||
      !rootId
    ) {
      return;
    }

    const queueLocally = conversationBusy && !opts?.force;
    if (opts?.existingSeq === undefined && opts?.content === undefined) {
      setDraft("");
      clearDraftAttachments();
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
      tempSeq = enqueuePendingNewChat(display, {
        queued: queueLocally,
        attachments,
        outboundText: trimmed,
      });
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
        attachments:
          attachments && attachments.length > 0 ? attachments : undefined,
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

  const sendThread = async (
    content: string,
    existingTempSeq?: number,
    attachments?: MessageAttachment[],
  ) => {
    const trimmed = content.trim();
    const display = formatOutboundContent(trimmed, attachments);
    if (
      (!trimmed && (!attachments || attachments.length === 0)) ||
      !connected ||
      !openAgentId
    ) {
      return;
    }

    const conversationHeld = running[openAgentId]?.conversation === true;
    const queueLocally = existingTempSeq === undefined && conversationHeld;

    let tempSeq: number;
    if (existingTempSeq !== undefined) {
      markPending(openAgentId, existingTempSeq);
      tempSeq = existingTempSeq;
    } else {
      tempSeq = addOptimistic(openAgentId, display, {
        queued: queueLocally,
        attachments,
        outboundText: trimmed,
      });
      setDraft("");
      clearDraftAttachments();
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
      const res = await dimaag.postMessage({
        to_agent_id: openAgentId,
        content: trimmed,
        attachments:
          attachments && attachments.length > 0 ? attachments : undefined,
      });
      resolveOptimistic(openAgentId, tempSeq, res.seq, res.content);
    } catch {
      markFailed(openAgentId, tempSeq);
    }
  };

  const flushQueues = useEffectEvent(async () => {
    if (!connected) {
      return;
    }

    if (rootId) {
      const queued = listQueuedPendingNewChat();
      for (const msg of queued) {
        await sendNewChat({
          content: msg.outboundText ?? msg.content,
          attachments: msg.attachments,
          existingSeq: msg.seq,
          force: true,
        });
      }
    }

    if (openAgentId) {
      const queued = listQueuedThread(openAgentId);
      for (const msg of queued) {
        await sendThread(
          msg.outboundText ?? msg.content,
          msg.seq,
          msg.attachments,
        );
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
    await sendNewChat({
      content: msg.outboundText ?? msg.content,
      attachments: msg.attachments,
      existingSeq: seq,
      force: true,
    });
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

  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    try {
      const next = await filesToDraftAttachments(files);
      setDraftAttachments((prev) => {
        const room = MAX_ATTACHMENTS - prev.length;
        if (room <= 0) {
          revokeDraftPreviews(next);
          return prev;
        }
        const keep = next.slice(0, room);
        revokeDraftPreviews(next.slice(room));
        return [...prev, ...keep];
      });
    } catch (err) {
      logLine(
        "error",
        err instanceof Error ? err.message : String(err),
        "invalid_request",
      );
    }
  };

  const removeDraftAttachment = (index: number) => {
    setDraftAttachments((prev) => {
      const target = prev[index];
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const attachments =
      draftAttachments.length > 0
        ? toMessageAttachments(draftAttachments)
        : undefined;
    if (openAgentId) {
      void sendThread(draft, undefined, attachments);
      return;
    }
    void sendNewChat({ attachments });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit(e as unknown as FormEvent);
    }
  };

  const isMobile = variant === "mobile";

  const backToList = () => {
    openList();
    setDraft("");
    clearDraftAttachments();
  };

  const startNewChat = () => {
    openList();
    setDraft("");
    clearDraftAttachments();
    onDrawerClose?.();
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const selectAgent = (agentId: string) => {
    openAgent(agentId);
    onDrawerClose?.();
  };

  const selectProvisional = () => {
    openProvisional();
    onDrawerClose?.();
  };

  const headerTitle = viewingProvisional
    ? "NEW CHAT"
    : openAgentId
      ? (openConversation?.agent_name ?? "CHAT").toUpperCase()
      : isMobile
        ? "દાદી"
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

  const canSubmit =
    connected &&
    (draft.trim().length > 0 || draftAttachments.length > 0);
  const composerPad =
    draftAttachments.length > 0 ? COMPOSER_PAD_WITH_ATTACH : COMPOSER_PAD;

  const { settled: settledMessages, queued: queuedMessages } = partitionByQueued(
    viewingProvisional ? provisionalMessages : threadMessages,
  );

  /** Hold pulse before drafts; working pulse at thread end when only reasoning is busy. */
  const showHoldPulse = conversationBusy || queuedMessages.length > 0;
  const showWorkingPulse =
    reasoningBusy && !conversationBusy && queuedMessages.length === 0;

  const showThreadMain = isMobile ? true : viewingThread;
  const showListInDrawer = isMobile;
  const showListInPanel = !isMobile && !viewingThread;

  return (
    <aside
      className={`relative flex h-full min-h-0 flex-col overflow-hidden ${
        isMobile ? "" : "widget-surface"
      } ${className ?? ""}`}
      data-agent-id={openAgentId ?? rootId ?? undefined}
      data-session-key={sessionKey}
      style={{ paddingBottom: keyboardInset > 0 ? keyboardInset : undefined }}
    >
      {!isMobile ? (
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
      ) : null}

      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          {showThreadMain && (viewingThread || isMobile) ? (
            viewingThread ? (
              <ThreadView
                viewKey={viewKey}
                scrollRef={scrollRef}
                onScroll={onScroll}
                onDismissKeyboard={dismissKeyboard}
                composerPad={composerPad}
                settledMessages={settledMessages}
                queuedMessages={queuedMessages}
                showHoldPulse={showHoldPulse}
                showWorkingPulse={showWorkingPulse}
                onRetry={(msg) => {
                  if (openAgentId) {
                    void sendThread(
                      msg.outboundText ?? msg.content,
                      msg.seq,
                      msg.attachments,
                    );
                    return;
                  }
                  if (viewingProvisional) {
                    void retryNewChat(msg.seq);
                  }
                }}
                onCancel={cancelQueued}
              />
            ) : (
              <motion.div
                key="mobile-empty"
                className="absolute inset-0 flex flex-col items-center justify-center px-8"
                style={{ paddingBottom: composerPad }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: SLOW_S, ease: EASE }}
              >
                <span className="font-gujarati text-[42px] leading-none text-sage-text">
                  દાદી
                </span>
                <p className="mt-4 max-w-[260px] text-center text-[14px] leading-relaxed text-ink-muted">
                  Ask anything. Your conversations live in the sidebar.
                </p>
                <button
                  type="button"
                  onClick={() => onDrawerOpen?.()}
                  className="mt-6 text-[11px] font-medium tracking-[2px] text-sage-deep"
                >
                  PREVIOUS CHATS
                </button>
              </motion.div>
            )
          ) : null}

          {showListInPanel ? (
            <ConversationList
              conversations={chat.conversations}
              pendingNewChat={chat.pendingNewChat}
              awaitingRoute={awaitingRoute}
              onOpenProvisional={openProvisional}
              onOpenAgent={openAgent}
              onDismissKeyboard={dismissKeyboard}
              composerPad={composerPad}
            />
          ) : null}
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
          fileInputRef={fileInputRef}
          cameraInputRef={cameraInputRef}
          attachments={draftAttachments}
          onRemoveAttachment={removeDraftAttachment}
          onPickFiles={onPickFiles}
          onSubmit={onSubmit}
          onKeyDown={onKeyDown}
        />
      </div>

      {showListInDrawer ? (
        <AnimatePresence>
          {drawerOpen ? (
            <>
              <motion.button
                type="button"
                aria-label="Close sidebar"
                className="absolute inset-0 z-30 bg-ink/25"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: SLOW_S, ease: EASE }}
                onClick={() => onDrawerClose?.()}
              />
              <motion.div
                className="glass-sheet absolute inset-y-0 left-0 z-40 flex w-[min(100%,320px)] flex-col overflow-hidden rounded-r-[var(--radius-window)]"
                initial={{ x: "-100%" }}
                animate={{ x: 0 }}
                exit={{ x: "-100%" }}
                transition={{ duration: SLOW_S, ease: EASE }}
              >
                <div className="flex items-center justify-between gap-2 border-b border-rule px-3 py-3">
                  <span className="font-gujarati text-[22px] leading-none text-sage-text">
                    દાદી
                  </span>
                  <IconButton
                    label="New chat"
                    size="sm"
                    onClick={startNewChat}
                  >
                    <IconNewChat />
                  </IconButton>
                </div>
                <button
                  type="button"
                  onClick={startNewChat}
                  className="mx-3 mt-3 rounded-[var(--radius)] border border-dashed border-sage-line bg-sage-fill/30 px-3 py-2.5 text-left text-[13px] text-ink transition-colors duration-slow ease-hath hover:bg-sage-active/40"
                >
                  New chat
                </button>
                <div className="relative min-h-0 flex-1">
                  <ConversationList
                    conversations={chat.conversations}
                    pendingNewChat={chat.pendingNewChat}
                    awaitingRoute={awaitingRoute}
                    onOpenProvisional={selectProvisional}
                    onOpenAgent={selectAgent}
                    onDismissKeyboard={dismissKeyboard}
                    composerPad={16}
                  />
                </div>
              </motion.div>
            </>
          ) : null}
        </AnimatePresence>
      ) : null}
    </aside>
  );
}
