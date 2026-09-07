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
import type { AgentRecord, LogRecord } from "../api/types";
import { useConnection } from "../hooks/useConnection";
import {
  AGENTS_QUERY_KEY,
  ROOT_AGENT_QUERY_KEY,
} from "../hooks/useEvents";
import {
  addOptimistic,
  enqueuePendingNewChat,
  getChatState,
  isUserThreadMessage,
  markFailed,
  markPending,
  markPendingNewChatFailed,
  markPendingNewChatMessageFailed,
  markPendingNewChatMessagePending,
  openAgent,
  openList,
  openProvisional,
  seedConversations,
  seedThread,
  subscribeChat,
  type ChatMessage,
  type Conversation,
} from "../store/chat";
import { getRunning, subscribeRunning } from "../store/running";
import { IconBack, IconButton, IconRetry, IconSend } from "../shared/IconButton";
import { EASE, SLOW_S } from "../shared/motion";

type ChatSidebarProps = {
  /** Bumps when chat opens; scrolls the thread to the bottom. */
  sessionKey: number;
  className?: string;
};

type MessagePayload = {
  from_agent_id: string | null;
  to_agent_id: string | null;
  content: string;
  seq: number;
};

const NEAR_BOTTOM_PX = 80;
const TEXTAREA_MAX_PX = 88;
const NEW_CHAT_TIMEOUT_MS = 90_000;
const COMPOSER_PAD = 72;

function parseMessagePayload(
  payload: Record<string, unknown>,
): MessagePayload | null {
  const seq = payload.seq;
  const content = payload.content;
  if (typeof seq !== "number" || typeof content !== "string") {
    return null;
  }
  const from =
    payload.from_agent_id === null || typeof payload.from_agent_id === "string"
      ? payload.from_agent_id
      : undefined;
  const to =
    payload.to_agent_id === null || typeof payload.to_agent_id === "string"
      ? payload.to_agent_id
      : undefined;
  if (from === undefined || to === undefined) {
    return null;
  }
  return { from_agent_id: from, to_agent_id: to, content, seq };
}

function logsToMessages(logs: LogRecord[]): ChatMessage[] {
  // Dimaag returns newest-first; reverse so the thread reads oldest → newest.
  //
  // agent_logs survives restarts but the in-process transcript does not. After
  // Dimaag restarts the client can show history Dimaag no longer has in context.
  // That divergence is correct for this architecture — do not reconcile.
  const chronological = [...logs].reverse();
  const out: ChatMessage[] = [];
  for (const log of chronological) {
    const payload = parseMessagePayload(log.payload);
    if (!payload) {
      continue;
    }
    if (!isUserThreadMessage(payload.from_agent_id, payload.to_agent_id)) {
      continue;
    }
    out.push({
      seq: payload.seq,
      from_user: payload.from_agent_id === null,
      content: payload.content,
      at: log.created_at,
    });
  }
  return out;
}

/**
 * Build conversation summaries from one cross-agent log page.
 *
 * Covers conversations that appear in the last 200 message events — for a
 * personal system that is effectively "all recent conversations," ordered by
 * recency. Completeness beyond that window is a Dimaag query change, not a
 * client N+1 over GET /agents/:id/logs.
 */
function buildConversations(
  logs: LogRecord[],
  agents: AgentRecord[],
  rootId: string,
): Conversation[] {
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const byAgent = new Map<string, Conversation>();
  // logs are newest-first; first hit per agent is the latest.
  for (const log of logs) {
    if (log.agent_id === rootId || byAgent.has(log.agent_id)) {
      continue;
    }
    const payload = parseMessagePayload(log.payload);
    if (!payload) {
      continue;
    }
    if (!isUserThreadMessage(payload.from_agent_id, payload.to_agent_id)) {
      continue;
    }
    const name = names.get(log.agent_id);
    if (!name) {
      continue;
    }
    byAgent.set(log.agent_id, {
      agent_id: log.agent_id,
      agent_name: name,
      last_message: payload.content,
      last_at: log.created_at,
      from_user: payload.from_agent_id === null,
    });
  }
  return [...byAgent.values()];
}

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
 * Conversation list + thread views. New-chat posts to root Dadi and opens a
 * provisional thread; route_message binds it to a child. Thread replies go to
 * that agent directly. Sidebar chrome stays mounted.
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

  const logsQuery = useQuery({
    queryKey: ["logs", "message", 200],
    queryFn: async () => {
      const { logs } = await dimaag.getLogs({ event: "message", limit: 200 });
      return logs;
    },
    enabled: connected && !!rootId,
  });

  const openAgentId =
    chat.open.kind === "agent" ? chat.open.agentId : null;
  const viewingProvisional = chat.open.kind === "provisional";
  const viewingThread = openAgentId !== null || viewingProvisional;

  const historyQuery = useQuery({
    queryKey: ["agent-logs", openAgentId, "message"],
    queryFn: async () => {
      if (!openAgentId) {
        throw new Error("openAgentId required");
      }
      const { logs } = await dimaag.getAgentLogs(openAgentId, {
        event: "message",
        limit: 100,
      });
      return logs;
    },
    enabled: connected && openAgentId !== null,
  });

  const onConversations = useEffectEvent(
    (logs: LogRecord[], agents: AgentRecord[], root: string) => {
      seedConversations(buildConversations(logs, agents, root));
    },
  );

  useEffect(() => {
    if (logsQuery.data && agentsQuery.data && rootId) {
      onConversations(logsQuery.data, agentsQuery.data, rootId);
    }
  }, [logsQuery.data, agentsQuery.data, rootId]);

  const onHistory = useEffectEvent((agentId: string, logs: LogRecord[]) => {
    seedThread(agentId, logsToMessages(logs));
  });

  useEffect(() => {
    if (openAgentId && historyQuery.data) {
      onHistory(openAgentId, historyQuery.data);
    }
  }, [openAgentId, historyQuery.data]);

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
        }))
      : [];

  const awaitingRoute =
    !!chat.pendingNewChat &&
    chat.pendingNewChat.messages.some((m) => !m.failed);
  const talkTargetName = openAgentId
    ? (openConversation?.agent_name ??
      agentsQuery.data?.find((a) => a.id === openAgentId)?.name ??
      "agent")
    : (rootQuery.data?.name ?? "Dadi");
  const thinkingAgentId =
    viewingProvisional && awaitingRoute
      ? (rootId ?? null)
      : openAgentId;
  // Provisional: keep the indicator up for the whole wait (not only while root's
  // lane lock is held). Bound threads follow the selected agent's conversation lane.
  const thinking =
    (viewingProvisional && awaitingRoute) ||
    (thinkingAgentId !== null &&
      running[thinkingAgentId]?.conversation === true);
  const recipientBusy =
    awaitingRoute ||
    (thinkingAgentId !== null &&
      running[thinkingAgentId]?.conversation === true) ||
    (!viewingThread &&
      !!rootId &&
      running[rootId]?.conversation === true);

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
  }, [threadMessages, provisionalMessages, thinking, viewingThread]);

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

  const sendNewChat = async () => {
    const trimmed = draft.trim();
    if (!trimmed || !connected || !rootId) {
      return;
    }

    setDraft("");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
      }
    });

    const tempSeq = enqueuePendingNewChat(trimmed);
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
        getChatState().pendingNewChat?.messages.every((m) => m.failed)
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

    let tempSeq: number;
    if (existingTempSeq !== undefined) {
      markPending(openAgentId, existingTempSeq);
      tempSeq = existingTempSeq;
    } else {
      tempSeq = addOptimistic(openAgentId, trimmed);
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

    try {
      await dimaag.postMessage({
        to_agent_id: openAgentId,
        content: trimmed,
      });
    } catch {
      markFailed(openAgentId, tempSeq);
    }
  };

  const retryNewChat = async (seq: number) => {
    const msg = chat.pendingNewChat?.messages.find((m) => m.seq === seq);
    if (!msg || !connected || !rootId) {
      return;
    }
    markPendingNewChatMessagePending(seq);
    clearNewChatTimer();
    newChatTimerRef.current = setTimeout(() => {
      markPendingNewChatFailed();
      newChatTimerRef.current = null;
    }, NEW_CHAT_TIMEOUT_MS);
    try {
      await dimaag.postMessage({ to_agent_id: rootId, content: msg.content });
    } catch {
      markPendingNewChatMessageFailed(seq);
      if (
        getChatState().pendingNewChat?.messages.every((m) => m.failed)
      ) {
        clearNewChatTimer();
      }
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

  const placeholder = recipientBusy
    ? `${talkTargetName} is busy`
    : `Talk to ${talkTargetName}`;

  const canSubmit = connected && draft.trim().length > 0;

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
            className="flex items-center gap-2.5"
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
            <span className="truncate text-[11px] font-medium tracking-[2.5px] text-sage-deep">
              {headerTitle}
            </span>
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
                  {(viewingProvisional
                    ? provisionalMessages
                    : threadMessages
                  ).map((msg) => (
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
                    />
                  ))}
                </AnimatePresence>
                {thinking ? <ThinkingIndicator /> : null}
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
                  {awaitingRoute ? (
                    <div className="mt-1.5">
                      <ThinkingIndicator compact />
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
          textareaRef={textareaRef}
          onSubmit={onSubmit}
          onKeyDown={onKeyDown}
        />
      </div>
    </aside>
  );
}

function FloatingComposer({
  connected,
  draft,
  setDraft,
  placeholder,
  canSubmit,
  textareaRef,
  onSubmit,
  onKeyDown,
}: {
  connected: boolean;
  draft: string;
  setDraft: (v: string) => void;
  placeholder: string;
  canSubmit: boolean;
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
          className="pointer-events-auto flex items-end gap-1.5 rounded-[var(--radius)] border border-dashed border-sage-line bg-bone/92 px-2 py-1.5 shadow-[var(--shadow)] backdrop-blur-md"
        >
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={placeholder}
            className="block max-h-[88px] min-h-[32px] w-full flex-1 resize-none overflow-y-auto bg-transparent px-1.5 py-1.5 text-[13px] leading-snug text-ink outline-none placeholder:text-ink-ghost"
            style={{ maxHeight: TEXTAREA_MAX_PX }}
          />
          <IconButton
            type="submit"
            label="Send"
            disabled={!canSubmit}
            size="lg"
            className="mb-px border-sage-line bg-sage-fill"
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
}: {
  message: ChatMessage;
  onRetry?: () => void;
}) {
  if (message.from_user) {
    const failed = Boolean(message.failed);
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: SLOW_S, ease: EASE }}
        className="flex items-end justify-end gap-1.5"
      >
        {failed && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            aria-label="Retry send"
            title="Retry"
            className="mb-0.5 inline-flex size-7 shrink-0 items-center justify-center text-[#b56b5c] transition-opacity duration-slow ease-hath hover:opacity-70"
          >
            <IconRetry />
          </button>
        ) : null}
        <div
          className={`max-w-[90%] rounded-[var(--radius)] px-3 py-1.5 text-[13px] leading-relaxed text-ink whitespace-pre-wrap ${
            failed
              ? "border border-[#c47868] bg-[#c47868]/12"
              : "bg-sage-active"
          }`}
          style={{ opacity: message.pending ? 0.55 : 1 }}
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

function ThinkingIndicator({ compact = false }: { compact?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
      className={`flex items-center gap-2.5 ${compact ? "py-0.5" : "py-1.5"}`}
      aria-label="Thinking"
    >
      <div className="relative flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="block size-1.5 rounded-full bg-sage"
            animate={{
              opacity: [0.25, 1, 0.25],
              y: [0, -3, 0],
              scale: [0.92, 1.08, 0.92],
            }}
            transition={{
              duration: 1.1,
              repeat: Infinity,
              delay: i * 0.15,
              ease: EASE,
            }}
          />
        ))}
        <motion.span
          className="pointer-events-none absolute -inset-x-2 -inset-y-1 rounded-[var(--radius)] bg-sage-fill"
          animate={{ opacity: [0.15, 0.4, 0.15] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: EASE }}
        />
      </div>
      {!compact ? (
        <motion.span
          className="text-[10px] font-medium tracking-[2.5px] text-sage-text"
          animate={{ opacity: [0.45, 1, 0.45] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: EASE }}
        >
          THINKING
        </motion.span>
      ) : null}
    </motion.div>
  );
}
