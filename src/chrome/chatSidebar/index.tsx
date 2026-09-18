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
import { dimaag, nas } from "../../shared/api";
import { BrowserFrame } from "../../features/agents/BrowserFrame";
import { TerminalChip } from "../../features/agents/TerminalChip";
import {
  pickLiveBrowser,
  pickLiveTerminal,
} from "../../features/agents/sessions";
import { useConnection } from "../../hooks/useConnection";
import {
  AGENTS_QUERY_KEY,
  ROOT_AGENT_QUERY_KEY,
} from "../../hooks/useEvents";
import {
  addOptimistic,
  clearLiveChat,
  formatOutboundContent,
  getChatState,
  hydrateFromLogs,
  listQueuedThread,
  markFailed,
  markPending,
  openAgent,
  openDadi,
  openList,
  removeMessage,
  resolveOptimistic,
  setChatRoot,
  subscribeChat,
  type MessageAttachment,
} from "../../store/chat";
import { getRunning, seedRunningFromAgents, subscribeRunning } from "../../store/running";
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
  HISTORY_LOG_LIMIT,
  NEAR_BOTTOM_PX,
  TEXTAREA_MAX_PX,
} from "./constants";
import { partitionByQueued } from "./lanes";
import { ConversationList } from "./list";
import { ThreadView } from "./thread";

export interface ChatSidebarProps {
  /** Bumps when chat opens; scrolls the thread to the bottom. */
  sessionKey: number;
  className?: string;
  /**
   * `rail` — desktop ChatGPT-style dark list ↔ thread.
   * `mobile` — main thread + optional list drawer controlled outside.
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
 * Conversation list + thread views. Live messages arrive via SSE; history is
 * hydrated from Dimaag `agent_logs` (user ↔ agent, including Talk to Dadi).
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

  const rootQuery = useQuery({
    queryKey: ROOT_AGENT_QUERY_KEY,
    queryFn: () => dimaag.getRootAgent(),
    enabled: connected,
    staleTime: Infinity,
  });
  const rootId = rootQuery.data?.id ?? chat.rootId;

  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: async () => {
      const { agents } = await dimaag.listAgents();
      seedRunningFromAgents(agents);
      return agents;
    },
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const browsersQuery = useQuery({
    queryKey: ["nas", "browsers"],
    queryFn: () => nas.listBrowsers(),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const terminalsQuery = useQuery({
    queryKey: ["nas", "terminals"],
    queryFn: () => nas.listTerminals(),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  useEffect(() => {
    if (rootQuery.data?.id) {
      setChatRoot(rootQuery.data.id);
    }
  }, [rootQuery.data?.id]);

  useEffect(() => {
    if (connection === "disconnected") {
      clearLiveChat();
    }
  }, [connection]);

  const openAgentId =
    chat.open.kind === "agent" ? chat.open.agentId : null;
  const viewingDadi = openAgentId !== null && openAgentId === rootId;
  const viewingThread = openAgentId !== null;
  const openConversation = chat.conversations.find(
    (c) => c.agent_id === openAgentId,
  );
  const threadMessages = openAgentId
    ? (chat.threads[openAgentId] ?? [])
    : [];

  const talkTargetName = viewingDadi
    ? (rootQuery.data?.name ?? "Dadi")
    : openAgentId
      ? (openConversation?.agent_name ??
        agentsQuery.data?.find((a) => a.id === openAgentId)?.name ??
        "agent")
      : (rootQuery.data?.name ?? "Dadi");

  const laneAgentId = openAgentId ?? (!viewingThread ? rootId : null);
  const conversationBusy =
    (laneAgentId !== null && running[laneAgentId]?.conversation === true) ||
    (!viewingThread && !!rootId && running[rootId]?.conversation === true);
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
  }, [threadMessages, conversationBusy, viewingThread]);

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

  const draftAttachmentsRef = useRef(draftAttachments);
  draftAttachmentsRef.current = draftAttachments;
  useEffect(() => {
    return () => {
      revokeDraftPreviews(draftAttachmentsRef.current);
    };
  }, []);

  useEffect(() => {
    if (!connected || !openAgentId) {
      return;
    }
    let cancelled = false;
    void dimaag
      .getAgentLogs(openAgentId, { event: "message", limit: HISTORY_LOG_LIMIT })
      .then(({ logs }) => {
        if (cancelled) {
          return;
        }
        const names = Object.fromEntries(
          (agentsQuery.data ?? []).map((a) => [a.id, a.name]),
        );
        if (rootQuery.data) {
          names[rootQuery.data.id] = rootQuery.data.name;
        }
        hydrateFromLogs(logs, names, getChatState().rootId);
      })
      .catch((err: unknown) => {
        logLine(
          "error",
          err instanceof Error ? err.message : String(err),
          "thread_history_failed",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [connected, openAgentId]);

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

  const clearDraftAttachments = () => {
    setDraftAttachments((prev) => {
      revokeDraftPreviews(prev);
      return [];
    });
  };

  const sendThread = async (
    toId: string,
    content: string,
    existingTempSeq?: number,
    attachments?: MessageAttachment[],
  ) => {
    const trimmed = content.trim();
    const display = formatOutboundContent(trimmed, attachments);
    if (
      (!trimmed && (!attachments || attachments.length === 0)) ||
      !connected
    ) {
      return;
    }

    const conversationHeld = running[toId]?.conversation === true;
    const queueLocally = existingTempSeq === undefined && conversationHeld;

    let tempSeq: number;
    if (existingTempSeq !== undefined) {
      markPending(toId, existingTempSeq);
      tempSeq = existingTempSeq;
    } else {
      tempSeq = addOptimistic(toId, display, {
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
        to_agent_id: toId,
        content: trimmed,
        attachments:
          attachments && attachments.length > 0 ? attachments : undefined,
      });
      resolveOptimistic(toId, tempSeq, res.seq, res.content);
    } catch {
      markFailed(toId, tempSeq);
    }
  };

  const flushQueues = useEffectEvent(async () => {
    if (!connected) {
      return;
    }
    const targetId = openAgentId ?? rootId;
    if (!targetId) {
      return;
    }
    const queued = listQueuedThread(targetId);
    for (const msg of queued) {
      await sendThread(
        targetId,
        msg.outboundText ?? msg.content,
        msg.seq,
        msg.attachments,
      );
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

  const cancelQueued = (seq: number) => {
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

  const resolveSendTarget = (): string | null => {
    if (openAgentId) {
      return openAgentId;
    }
    return rootId ?? null;
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const attachments =
      draftAttachments.length > 0
        ? toMessageAttachments(draftAttachments)
        : undefined;
    const toId = resolveSendTarget();
    if (!toId) {
      return;
    }
    if (!openAgentId) {
      openAgent(toId);
    }
    void sendThread(toId, draft, undefined, attachments);
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
    setDraft("");
    clearDraftAttachments();
    if (!openDadi()) {
      openList();
    }
    onDrawerClose?.();
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const selectAgent = (agentId: string) => {
    openAgent(agentId);
    onDrawerClose?.();
  };

  const headerTitle = viewingDadi
    ? (rootQuery.data?.name ?? "Dadi")
    : openAgentId
      ? (openConversation?.agent_name ??
        agentsQuery.data?.find((a) => a.id === openAgentId)?.name ??
        "Chat")
      : "Dadi";

  const viewKey = chat.open.kind === "list" ? "list" : chat.open.agentId;

  const placeholder =
    connected && !openAgentId && !rootId
      ? rootQuery.isError
        ? "Dadi is unreachable"
        : "Waiting for Dadi…"
      : conversationBusy
        ? `Held for ${talkTargetName}…`
        : `Message ${talkTargetName}`;

  const canSubmit =
    connected &&
    (draft.trim().length > 0 || draftAttachments.length > 0) &&
    resolveSendTarget() !== null;
  const composerPad =
    draftAttachments.length > 0 ? COMPOSER_PAD_WITH_ATTACH : COMPOSER_PAD;

  const { settled: settledMessages, queued: queuedMessages } = partitionByQueued(
    threadMessages,
  );

  const showHoldPulse = conversationBusy || queuedMessages.length > 0;
  const showWorkingPulse =
    reasoningBusy && !conversationBusy && queuedMessages.length === 0;

  const openAgentRecord = openAgentId
    ? agentsQuery.data?.find((a) => a.id === openAgentId)
    : undefined;
  const liveBrowserId =
    openAgentRecord && browsersQuery.isSuccess
      ? pickLiveBrowser(
          openAgentRecord.sessions.browsers,
          browsersQuery.data,
        )
      : null;
  const liveTerminal =
    openAgentRecord && terminalsQuery.isSuccess
      ? pickLiveTerminal(
          openAgentRecord.sessions.terminals,
          terminalsQuery.data,
        )
      : null;
  const showHostOverlay =
    viewingThread && (liveBrowserId !== null || liveTerminal !== null);

  const showThreadMain = isMobile ? true : viewingThread;
  const showListInDrawer = isMobile;
  const showListInPanel = !isMobile && !viewingThread;
  const showComposer = isMobile || viewingThread;

  const dadiMessages = rootId ? (chat.threads[rootId] ?? []) : [];
  const dadiPreview =
    dadiMessages.length > 0
      ? dadiMessages[dadiMessages.length - 1]!.content
      : null;

  const list = (
    <ConversationList
      conversations={chat.conversations}
      selectedAgentId={openAgentId}
      historyStatus={chat.historyStatus}
      historyError={chat.historyError}
      onOpenAgent={isMobile ? selectAgent : openAgent}
      onDismissKeyboard={dismissKeyboard}
      dadi={{
        available: !!rootId,
        selected: viewingDadi,
        preview: dadiPreview,
        busy: !!rootId && running[rootId]?.conversation === true,
        onOpen: startNewChat,
      }}
    />
  );

  return (
    <aside
      className={`relative flex h-full min-h-0 flex-col overflow-hidden ${
        isMobile ? "" : "chat-rail"
      } ${className ?? ""}`}
      data-agent-id={openAgentId ?? rootId ?? undefined}
      data-session-key={sessionKey}
      style={{ paddingBottom: keyboardInset > 0 ? keyboardInset : undefined }}
    >
      {!isMobile ? (
        <div className="relative z-10 flex h-12 shrink-0 items-center justify-between gap-2 border-b border-(--chat-edge) px-3">
          {viewingThread ? (
            <button
              type="button"
              onClick={backToList}
              className="flex min-w-0 items-center gap-1.5 text-ink"
              aria-label="Back to conversations"
            >
              <span className="inline-flex size-3.5 shrink-0 [&_svg]:size-full">
                <IconBack />
              </span>
              <motion.span
                className="truncate text-[14px] font-medium"
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
            </button>
          ) : (
            <span className="font-gujarati text-[22px] leading-none text-sage-text">
              દાદી
            </span>
          )}
          <IconButton
            label="Talk to Dadi"
            size="sm"
            onClick={startNewChat}
            className="border-transparent bg-transparent text-ink-muted shadow-none hover:bg-(--chat-hover) hover:text-ink"
          >
            <IconNewChat />
          </IconButton>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {showHostOverlay ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-stretch gap-1.5 px-4 pt-2">
            {liveTerminal ? (
              <TerminalChip
                command={liveTerminal.last_command}
                terminalId={liveTerminal.id}
                className="self-start"
              />
            ) : null}
            {liveBrowserId !== null ? (
              <BrowserFrame browserId={liveBrowserId} variant="rail" />
            ) : null}
          </div>
        ) : null}
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
                      openAgentId,
                      msg.outboundText ?? msg.content,
                      msg.seq,
                      msg.attachments,
                    );
                  }
                }}
                onCancel={cancelQueued}
                onRevealTick={() => {
                  if (stickToBottomRef.current) {
                    scrollToBottom("auto");
                  }
                }}
                emptyHint={
                  viewingDadi
                    ? "Talk to Dadi — it will route you."
                    : `Message ${talkTargetName}`
                }
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
                <p className="mt-4 max-w-65 text-center text-[14px] leading-relaxed text-ink-muted">
                  Ask anything. Dadi will route you, or pick a chat from the sidebar.
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

          {showListInPanel ? list : null}
        </AnimatePresence>

        {showComposer ? (
          <FloatingComposer
            connected={connected}
            draft={draft}
            setDraft={setDraft}
            placeholder={placeholder}
            canSubmit={canSubmit}
            holdMode={conversationBusy}
            workingMode={reasoningBusy && !conversationBusy}
            targetName={talkTargetName}
            textareaRef={textareaRef}
            fileInputRef={fileInputRef}
            cameraInputRef={cameraInputRef}
            attachments={draftAttachments}
            onRemoveAttachment={removeDraftAttachment}
            onPickFiles={onPickFiles}
            onSubmit={onSubmit}
            onKeyDown={onKeyDown}
          />
        ) : null}
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
                className="chat-rail absolute inset-y-0 left-0 z-40 flex w-[min(100%,300px)] flex-col overflow-hidden rounded-r-2xl"
                initial={{ x: "-100%" }}
                animate={{ x: 0 }}
                exit={{ x: "-100%" }}
                transition={{ duration: SLOW_S, ease: EASE }}
              >
                <div className="flex items-center justify-between gap-2 px-3 py-3">
                  <span className="font-gujarati text-[22px] leading-none text-sage-text">
                    દાદી
                  </span>
                  <IconButton
                    label="Talk to Dadi"
                    size="sm"
                    onClick={startNewChat}
                    className="border-transparent bg-transparent text-ink-muted shadow-none hover:bg-(--chat-hover) hover:text-ink"
                  >
                    <IconNewChat />
                  </IconButton>
                </div>
                <div className="relative min-h-0 flex-1">{list}</div>
              </motion.div>
            </>
          ) : null}
        </AnimatePresence>
      ) : null}
    </aside>
  );
}
