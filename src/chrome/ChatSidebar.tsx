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
import { dimaag } from "../api";
import type { AgentRecord, LogRecord } from "../api/types";
import { useConnection } from "../hooks/useConnection";
import {
  AGENTS_QUERY_KEY,
  ROOT_AGENT_QUERY_KEY,
} from "../hooks/useEvents";
import {
  addOptimistic,
  clearPendingNewChat,
  getChatState,
  isUserThreadMessage,
  markFailed,
  markPending,
  markPendingNewChatFailed,
  removeMessage,
  seedConversations,
  seedThread,
  setPendingNewChat,
  subscribeChat,
  type ChatMessage,
  type Conversation,
} from "../store/chat";
import { getRunning, subscribeRunning } from "../store/running";

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
const TEXTAREA_MAX_PX = 120;
const NEW_CHAT_TIMEOUT_MS = 90_000;

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
 * Conversation list + thread views. New-chat input routes through root Dadi;
 * thread replies go to that agent directly. Sidebar chrome stays mounted.
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

  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [listDraft, setListDraft] = useState("");
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
  const thinking =
    openAgentId !== null &&
    running[openAgentId]?.conversation === true;

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
  }, [sessionKey, openAgentId]);

  useEffect(() => {
    if (openAgentId && stickToBottomRef.current) {
      scrollToBottom("smooth");
    }
  }, [threadMessages, thinking, openAgentId]);

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
  }, [draft, listDraft, openAgentId]);

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
    const trimmed = listDraft.trim();
    if (!trimmed || !connected || !rootId) {
      return;
    }

    setListDraft("");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
      }
    });

    setPendingNewChat({ content: trimmed, at: new Date().toISOString() });
    clearNewChatTimer();
    newChatTimerRef.current = setTimeout(() => {
      markPendingNewChatFailed();
      newChatTimerRef.current = null;
    }, NEW_CHAT_TIMEOUT_MS);

    try {
      await dimaag.postMessage({
        to_agent_id: rootId,
        content: trimmed,
      });
    } catch {
      clearNewChatTimer();
      markPendingNewChatFailed();
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

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (openAgentId) {
      void sendThread(draft);
    } else {
      void sendNewChat();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (openAgentId) {
        void sendThread(draft);
      } else {
        void sendNewChat();
      }
    }
  };

  const backToList = () => {
    setOpenAgentId(null);
    setDraft("");
  };

  return (
    <aside
      className={`widget-surface flex h-full min-h-0 flex-col overflow-hidden ${className ?? ""}`}
      data-agent-id={openAgentId ?? rootId ?? undefined}
      data-session-key={sessionKey}
      style={{ paddingBottom: keyboardInset > 0 ? keyboardInset : undefined }}
    >
      <div className="border-b border-dashed border-sage-line px-4 py-3">
        {openAgentId ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={backToList}
              className="text-[11px] font-medium tracking-[2.5px] text-sage-deep"
            >
              ←
            </button>
            <span className="truncate text-[11px] font-medium tracking-[2.5px] text-sage-deep">
              {(openConversation?.agent_name ?? "CHAT").toUpperCase()}
            </span>
          </div>
        ) : (
          <span className="text-[11px] font-medium tracking-[2.5px] text-sage-deep">
            CHAT
          </span>
        )}
      </div>

      {openAgentId ? (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onClick={dismissKeyboard}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        >
          <div className="flex flex-col gap-3">
            {threadMessages.map((msg) => (
              <MessageBubble
                key={msg.seq}
                message={msg}
                onRetry={() => void sendThread(msg.content, msg.seq)}
                onDismiss={() => removeMessage(openAgentId, msg.seq)}
              />
            ))}
            {thinking && <ThinkingIndicator />}
          </div>
        </div>
      ) : (
        <div
          onClick={dismissKeyboard}
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
        >
          {chat.pendingNewChat && (
            <div className="rounded-[var(--radius)] px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] text-ink">New chat</span>
                <span className="shrink-0 text-[11px] text-ink-ghost">
                  {formatRelative(chat.pendingNewChat.at)}
                </span>
              </div>
              <p
                className="mt-0.5 truncate text-[12px] text-ink-ghost"
                style={{ opacity: chat.pendingNewChat.failed ? 0.7 : 1 }}
              >
                {truncateOneLine(chat.pendingNewChat.content)}
              </p>
              {chat.pendingNewChat.failed ? (
                <div className="mt-1.5 flex items-center gap-2 text-[11px] text-sage-text">
                  <span>No reply yet</span>
                  <button
                    type="button"
                    onClick={() => {
                      clearNewChatTimer();
                      clearPendingNewChat();
                    }}
                    className="underline decoration-dashed underline-offset-2"
                  >
                    Dismiss
                  </button>
                </div>
              ) : (
                <div className="mt-2">
                  <ThinkingIndicator />
                </div>
              )}
            </div>
          )}

          {chat.conversations.length === 0 && !chat.pendingNewChat ? (
            <p className="px-3 py-6 text-[13px] text-ink-ghost">
              No conversations yet
            </p>
          ) : (
            chat.conversations.map((conv) => (
              <button
                key={conv.agent_id}
                type="button"
                onClick={() => setOpenAgentId(conv.agent_id)}
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
              </button>
            ))
          )}
        </div>
      )}

      <div
        className="border-t border-dashed border-sage-line px-3 pt-3"
        style={{
          paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
        }}
      >
        {connected ? (
          <form onSubmit={onSubmit}>
            <textarea
              ref={textareaRef}
              value={openAgentId ? draft : listDraft}
              onChange={(e) =>
                openAgentId
                  ? setDraft(e.target.value)
                  : setListDraft(e.target.value)
              }
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={
                openAgentId ? "Message…" : "New chat…"
              }
              className="block w-full resize-none overflow-y-auto rounded-[var(--radius)] border border-dashed border-sage-line bg-bone px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-ghost focus:border-sage-line"
              style={{ maxHeight: TEXTAREA_MAX_PX }}
            />
          </form>
        ) : (
          <div className="rounded-[var(--radius)] border border-dashed border-sage-line bg-bone px-3 py-2.5 text-[13px] text-ink-ghost">
            Connect to message Dadi
          </div>
        )}
      </div>
    </aside>
  );
}

function MessageBubble({
  message,
  onRetry,
  onDismiss,
}: {
  message: ChatMessage;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  if (message.from_user) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div
          className="max-w-[90%] rounded-[var(--radius)] bg-sage-active px-3 py-2 text-[13px] leading-relaxed text-ink whitespace-pre-wrap transition-opacity duration-slow ease-hath"
          style={{ opacity: message.pending ? 0.55 : 1 }}
        >
          {message.content}
        </div>
        {message.failed && (
          <div className="flex items-center gap-2 text-[11px] text-sage-text">
            <span>Couldn&apos;t send</span>
            <button
              type="button"
              onClick={onRetry}
              className="underline decoration-dashed underline-offset-2"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="underline decoration-dashed underline-offset-2"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-[95%] text-[13px] leading-[1.65] text-ink whitespace-pre-wrap">
      {message.content}
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-1 py-1" aria-label="Thinking">
      <span className="size-1.5 rounded-full bg-sage animate-breath" />
      <span
        className="size-1.5 rounded-full bg-sage animate-breath"
        style={{ animationDelay: "0.4s" }}
      />
      <span
        className="size-1.5 rounded-full bg-sage animate-breath"
        style={{ animationDelay: "0.8s" }}
      />
    </div>
  );
}
