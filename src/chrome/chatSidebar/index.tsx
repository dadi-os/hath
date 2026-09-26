import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { dimaag, nas } from "../../shared/api";
import { HostPin } from "./HostPin";
import {
  pickLiveBrowser,
  pickLiveTerminal,
} from "../../features/agents/sessions";
import { useConnection } from "../../hooks/useConnection";
import { AGENTS_QUERY_KEY } from "../../hooks/useEvents";
import { isMeshOnline } from "../../shared/api";
import {
  addOptimistic,
  clearLiveChat,
  formatOutboundContent,
  getChatState,
  hydrateThreadMessages,
  ingestLiveMessage,
  listQueuedThread,
  markFailed,
  markPending,
  openAgent,
  openDadi,
  openList,
  removeMessage,
  resolveOptimistic,
  setHistoryState,
  subscribeChat,
  type MessageAttachment,
} from "../../store/chat";
import { DADI_DRAFT_KEY, loadDraft, saveDraft } from "../../store/drafts";
import {
  getRunning,
  isDadiBusy,
  seedRunningFromAgents,
  setDadiBusy,
  subscribeRunning,
} from "../../store/running";
import {
  filesToDraftAttachments,
  MAX_ATTACHMENTS,
  revokeDraftPreviews,
  toMessageAttachments,
  type DraftAttachment,
} from "../../shared/lib/content/attachments";
import { IconBack } from "../../shared/components/IconButton";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";
import { POLL_MS } from "../../shared/lib/ux/poll";
import { logLine } from "../../shared/lib/platform/log";
import { FloatingComposer } from "./composer";
import {
  COMPOSER_GAP,
  HISTORY_LOG_LIMIT,
  NEAR_BOTTOM_PX,
  TEXTAREA_MAX_PX,
  THREAD_REFRESH_MS,
} from "./constants";
import { DadiHome, type DadiRouting } from "./DadiHome";
import { partitionByQueued } from "./lanes";
import { ConversationList } from "./list";
import { ThreadView } from "./thread";
import { laneChipLabel } from "./toolStatus";

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
 * loaded from durable Dimaag `GET /threads` and `GET /agents/:id/messages`.
 * Talk to Dadi is a composer onto POST /dadi.
 */
export function ChatSidebar({
  sessionKey,
  className,
  variant = "rail",
  drawerOpen = false,
  onDrawerClose,
  onDrawerOpen,
}: ChatSidebarProps) {
  const queryClient = useQueryClient();
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);
  const chat = useSyncExternalStore(subscribeChat, getChatState, getChatState);
  const running = useSyncExternalStore(
    subscribeRunning,
    getRunning,
    getRunning,
  );

  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>(
    [],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const stickToBottomRef = useRef(true);
  const [keyboardInset, setKeyboardInset] = useState(0);
  /** Talk to Dadi send in flight: the text being routed, until a thread opens. */
  const [routing, setRouting] = useState<DadiRouting | null>(null);
  /** Server message from the last failed Talk to Dadi send. */
  const [routeError, setRouteError] = useState<string | null>(null);
  /** First history fetch outcome per open thread; the empty state waits on it. */
  const [threadLoad, setThreadLoad] = useState<{
    agentId: string;
    error: string | null;
  } | null>(null);
  /** Measured floating composer height; the thread pads by it so text clears it. */
  const [composerHeight, setComposerHeight] = useState(0);
  const refreshThreadRef = useRef<(() => void) | null>(null);

  const dadiBusy = isDadiBusy();

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
    if (connection === "disconnected") {
      clearLiveChat();
      setDadiBusy(false);
    }
  }, [connection]);

  const openAgentId =
    chat.open.kind === "agent" ? chat.open.agentId : null;
  const viewingDadi = chat.open.kind === "dadi";
  const viewingThread = chat.open.kind === "agent";
  const openConversation = chat.conversations.find(
    (c) => c.agent_id === openAgentId,
  );
  const threadMessages = openAgentId
    ? (chat.threads[openAgentId] ?? [])
    : [];

  const draftKey = openAgentId ?? DADI_DRAFT_KEY;
  const draftKeyRef = useRef(draftKey);
  const [draft, setDraftText] = useState(() => loadDraft(draftKey));
  const setDraft = (text: string) => {
    setDraftText(text);
    saveDraft(draftKeyRef.current, text);
    if (routeError) {
      setRouteError(null);
    }
  };
  useLayoutEffect(() => {
    if (draftKeyRef.current === draftKey) {
      return;
    }
    draftKeyRef.current = draftKey;
    setDraftText(loadDraft(draftKey));
    setDraftAttachments((prev) => {
      revokeDraftPreviews(prev);
      return [];
    });
  }, [draftKey]);

  const conversationBusy =
    viewingThread && openAgentId
      ? running[openAgentId]?.conversation === true
      : dadiBusy;
  const reasoningBusy =
    viewingThread && openAgentId
      ? running[openAgentId]?.reasoning === true
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

  useLayoutEffect(() => {
    if (!viewingThread || !stickToBottomRef.current) {
      return;
    }
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [threadMessages, conversationBusy, reasoningBusy, viewingThread, composerHeight]);

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

  /**
   * Load the open thread, then keep it fresh. SSE has no replay, so a dropped
   * stream or tunnel flap would otherwise hide replies until the thread is
   * reopened. Refreshes run on an interval, when the agent's conversation lane
   * goes idle, and when the window regains focus.
   */
  useEffect(() => {
    if (!connected || !openAgentId) {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let first = true;
    const load = () => {
      if (inFlight || cancelled) {
        return;
      }
      inFlight = true;
      const live = !first;
      void dimaag
        .listMessages(openAgentId, { limit: HISTORY_LOG_LIMIT })
        .then(({ messages }) => {
          if (cancelled) {
            return;
          }
          first = false;
          hydrateThreadMessages(openAgentId, messages, { live });
          setThreadLoad({ agentId: openAgentId, error: null });
        })
        .catch((err: unknown) => {
          if (cancelled) {
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          if (live) {
            logLine("warn", message, "thread_refresh_failed");
            return;
          }
          logLine("error", message, "thread_history_failed");
          setHistoryState("error", message);
          setThreadLoad({ agentId: openAgentId, error: message });
        })
        .finally(() => {
          inFlight = false;
        });
    };
    load();
    refreshThreadRef.current = load;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        load();
      }
    }, THREAD_REFRESH_MS);
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", load);
      if (refreshThreadRef.current === load) {
        refreshThreadRef.current = null;
      }
    };
  }, [connected, openAgentId, chat.historyStatus]);

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
    const targetId = openAgentId;
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
    refreshThreadRef.current?.();
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

  /** Speak to the router; on route, jump into the thread. */
  const sendDadi = async (
    content: string,
    attachments?: MessageAttachment[],
  ) => {
    const trimmed = content.trim();
    if (
      (!trimmed && (!attachments || attachments.length === 0)) ||
      !connected ||
      dadiBusy
    ) {
      return;
    }
    const savedDraft = draft;
    const savedAttachments = draftAttachments;
    setDraft("");
    setRouteError(null);
    setRouting({ text: trimmed, attachments: attachments?.length ?? 0 });
    setDadiBusy(true);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    try {
      const res = await dimaag.postDadi({
        content: trimmed,
        attachments:
          attachments && attachments.length > 0 ? attachments : undefined,
      });
      clearDraftAttachments();
      if (res.action === "routed") {
        openAgent(res.thread_id);
        ingestLiveMessage(res.thread_id, {
          seq: res.seq,
          from_user: true,
          content: res.content,
          at: res.created_at,
        });
        return;
      }
      if (res.action === "modified") {
        void queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
        void queryClient.invalidateQueries({
          queryKey: ["agent", res.agent_id],
        });
        openAgent(res.agent_id);
        return;
      }
      const _exhaustive: never = res;
      void _exhaustive;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      saveDraft(DADI_DRAFT_KEY, savedDraft);
      if (draftKeyRef.current === DADI_DRAFT_KEY) {
        setDraftText(savedDraft);
        setDraftAttachments(savedAttachments);
        setRouteError(message);
      }
      logLine("error", message, "dadi_send_failed");
    } finally {
      setRouting(null);
      setDadiBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const attachments =
      draftAttachments.length > 0
        ? toMessageAttachments(draftAttachments)
        : undefined;
    if (viewingThread && openAgentId) {
      void sendThread(openAgentId, draft, undefined, attachments);
      return;
    }
    void sendDadi(draft, attachments);
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
    clearDraftAttachments();
    setRouteError(null);
  };

  const startNewChat = () => {
    clearDraftAttachments();
    setRouteError(null);
    openDadi();
    onDrawerClose?.();
  };

  const selectAgent = (agentId: string) => {
    openAgent(agentId);
    onDrawerClose?.();
  };

  const headerTitle = viewingThread
    ? (openConversation?.agent_name ??
      agentsQuery.data?.find((a) => a.id === openAgentId)?.name ??
      "Chat")
    : "Dadi";

  const placeholder = !connected
    ? "Connect to message Dadi"
    : viewingDadi
      ? "Message Dadi…"
      : conversationBusy
        ? `Thinking…`
        : `Message agent`;

  const canSubmit =
    connected &&
    !dadiBusy &&
    (draft.trim().length > 0 || draftAttachments.length > 0);
  const composerPad = composerHeight + COMPOSER_GAP;

  const { settled: settledMessages, queued: queuedMessages } = partitionByQueued(
    threadMessages,
  );

  const laneBusy = conversationBusy || reasoningBusy;
  const laneLabel = laneChipLabel(conversationBusy, reasoningBusy);

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
  const showHostPin =
    viewingThread && (liveBrowserId !== null || liveTerminal !== null);

  const showListInDrawer = isMobile;
  const showComposer = isMobile || viewingThread || viewingDadi;

  const paneKey = viewingThread
    ? `agent:${openAgentId ?? ""}`
    : viewingDadi
      ? "dadi"
      : isMobile
        ? "mobile-empty"
        : "list";

  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const paneTransition = {
    duration: reducedMotion ? 0 : 0.24,
    ease: EASE,
  };

  const listProps = {
    conversations: chat.conversations,
    selectedAgentId: openAgentId,
    historyStatus: chat.historyStatus,
    historyError: chat.historyError,
    onOpenAgent: isMobile ? selectAgent : openAgent,
    onDismissKeyboard: dismissKeyboard,
    dadi: {
      available: connected,
      selected: viewingDadi,
      preview: null as string | null,
      busy: dadiBusy,
      onOpen: startNewChat,
    },
  };

  return (
    <aside
      className={`relative flex h-full min-h-0 flex-col overflow-hidden ${
        isMobile ? "" : "chat-rail"
      } ${className ?? ""}`}
      data-agent-id={openAgentId ?? undefined}
      data-session-key={sessionKey}
      style={{ paddingBottom: keyboardInset > 0 ? keyboardInset : undefined }}
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={paneKey}
            className="absolute inset-0 flex flex-col"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 18, pointerEvents: "none" }}
            transition={paneTransition}
          >
            {paneKey === "list" ? (
              <ConversationList {...listProps} />
            ) : null}

            {paneKey === "dadi" ? (
              <>
                {!isMobile ? (
                  <div className="relative z-10 flex h-12 shrink-0 items-center gap-2 border-b border-(--chat-edge) px-3">
                    <motion.button
                      type="button"
                      onClick={backToList}
                      aria-label="Back to conversations"
                      whileHover={{ x: -2 }}
                      whileTap={{ scale: 0.97 }}
                      transition={{ duration: 0.2, ease: EASE }}
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors duration-fast ease-hath hover:bg-sage-active/50 hover:text-ink [&_svg]:size-3.5"
                    >
                      <IconBack />
                    </motion.button>
                    <motion.span
                      className="min-w-0 truncate text-[14px] font-medium text-ink"
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
                  </div>
                ) : null}
                <div className="relative min-h-0 flex-1">
                  <DadiHome
                    composerPad={composerPad}
                    routing={routing}
                    error={routeError}
                  />
                </div>
              </>
            ) : null}

            {viewingThread ? (
              <>
                {!isMobile ? (
                  <div className="relative z-10 flex h-12 shrink-0 items-center gap-2 border-b border-(--chat-edge) px-3">
                    <motion.button
                      type="button"
                      onClick={backToList}
                      aria-label="Back to conversations"
                      whileHover={{ x: -2 }}
                      whileTap={{ scale: 0.97 }}
                      transition={{ duration: 0.2, ease: EASE }}
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors duration-fast ease-hath hover:bg-sage-active/50 hover:text-ink [&_svg]:size-3.5"
                    >
                      <IconBack />
                    </motion.button>
                    <motion.span
                      className="min-w-0 truncate text-[14px] font-medium text-ink"
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
                  </div>
                ) : null}
                <div className="relative flex min-h-0 flex-1 flex-col">
                  {showHostPin ? (
                    <HostPin browserId={liveBrowserId} terminal={liveTerminal} />
                  ) : null}
                  <div className="relative min-h-0 flex-1">
                    {openAgentId ? (
                    <ThreadView
                      scrollRef={scrollRef}
                      onScroll={onScroll}
                      onDismissKeyboard={dismissKeyboard}
                      composerPad={composerPad}
                      fadeTop={showHostPin}
                      settledMessages={settledMessages}
                      queuedMessages={queuedMessages}
                      agentId={openAgentId}
                      laneBusy={laneBusy}
                      onRetry={(msg) => {
                        void sendThread(
                          openAgentId,
                          msg.outboundText ?? msg.content,
                          msg.seq,
                          msg.attachments,
                        );
                      }}
                      onCancel={cancelQueued}
                      onRevealTick={() => {
                        if (stickToBottomRef.current) {
                          scrollToBottom("auto");
                        }
                      }}
                      agentName={headerTitle}
                      agent={openAgentRecord}
                      load={
                        threadLoad?.agentId === openAgentId ? threadLoad : null
                      }
                      onSuggest={(text) => {
                        setDraft(text);
                        requestAnimationFrame(() => {
                          textareaRef.current?.focus();
                        });
                      }}
                    />
                    ) : null}
                  </div>
                </div>
              </>
            ) : null}

            {paneKey === "mobile-empty" && (routing || routeError) ? (
              <DadiHome
                composerPad={composerPad}
                routing={routing}
                error={routeError}
              />
            ) : null}

            {paneKey === "mobile-empty" && !routing && !routeError ? (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center px-8"
                style={{ paddingBottom: composerPad }}
              >
                <span className="font-gujarati text-[42px] leading-none text-sage-text">
                  દાદી
                </span>
                <p className="mt-4 max-w-65 text-center text-[14px] leading-relaxed text-ink-muted">
                  Talk to Dadi about anything
                </p>
                <button
                  type="button"
                  onClick={() => onDrawerOpen?.()}
                  className="mt-6 text-[11px] font-medium tracking-[2px] text-sage-deep"
                >
                  PREVIOUS CHATS
                </button>
              </div>
            ) : null}
          </motion.div>
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {showComposer ? (
            <FloatingComposer
              key="composer"
              connected={connected}
              draft={draft}
              setDraft={setDraft}
              placeholder={placeholder}
              canSubmit={canSubmit}
              thinkingMode={conversationBusy}
              workingMode={reasoningBusy && !conversationBusy}
              laneLabel={laneLabel}
              textareaRef={textareaRef}
              fileInputRef={fileInputRef}
              cameraInputRef={cameraInputRef}
              attachments={draftAttachments}
              onRemoveAttachment={removeDraftAttachment}
              onPickFiles={onPickFiles}
              onSubmit={onSubmit}
              onKeyDown={onKeyDown}
              autoFocus={viewingDadi}
              onHeight={setComposerHeight}
            />
          ) : null}
        </AnimatePresence>
      </div>

      {showListInDrawer ? (
        <AnimatePresence>
          {drawerOpen ? (
            <motion.button
              key="drawer-scrim"
              type="button"
              aria-label="Close sidebar"
              className="absolute inset-0 z-30 bg-ink/25"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: SLOW_S, ease: EASE }}
              onClick={() => onDrawerClose?.()}
            />
          ) : null}
          {drawerOpen ? (
            <motion.div
              key="drawer-panel"
              className="chat-rail absolute inset-y-0 left-0 z-40 flex w-[min(100%,300px)] flex-col overflow-hidden rounded-r-2xl"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: SLOW_S, ease: EASE }}
            >
              <div className="h-2 shrink-0" aria-hidden />
              <div className="relative min-h-0 flex-1">
                <ConversationList {...listProps} />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      ) : null}
    </aside>
  );
}
