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
import { ROOT_DADI_ID } from "../api/types";
import type { LogRecord } from "../api/types";
import { useConnection } from "../hooks/useConnection";
import {
  addOptimistic,
  getChatState,
  isUserThreadMessage,
  markFailed,
  markPending,
  removeMessage,
  seedMessages,
  subscribeChat,
  type ChatMessage,
} from "../store/chat";

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

function parseMessagePayload(payload: Record<string, unknown>): MessagePayload | null {
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
 * Continuous conversation with root Dadi. History from agent_logs; live
 * appends from the event stream. No thread spawning — spawn_agent is a tool.
 */
export function ChatSidebar({ sessionKey, className }: ChatSidebarProps) {
  const { state: connection } = useConnection();
  const connected = connection === "connected";
  const chat = useSyncExternalStore(subscribeChat, getChatState, getChatState);

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);
  const [keyboardInset, setKeyboardInset] = useState(0);

  const historyQuery = useQuery({
    queryKey: ["agent-logs", ROOT_DADI_ID, "message"],
    queryFn: async () => {
      const { logs } = await dimaag.getAgentLogs(ROOT_DADI_ID, {
        event: "message",
        limit: 100,
      });
      return logs;
    },
    enabled: connected,
  });

  const onHistory = useEffectEvent((logs: LogRecord[]) => {
    seedMessages(logsToMessages(logs));
  });

  useEffect(() => {
    if (historyQuery.data) {
      onHistory(historyQuery.data);
    }
  }, [historyQuery.data]);

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
  }, [sessionKey]);

  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollToBottom("smooth");
    }
  }, [chat.messages, chat.thinking]);

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
  }, [draft]);

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

  const sendContent = async (content: string, existingTempSeq?: number) => {
    const trimmed = content.trim();
    if (!trimmed || !connected) {
      return;
    }

    let tempSeq: number;
    if (existingTempSeq !== undefined) {
      markPending(existingTempSeq);
      tempSeq = existingTempSeq;
    } else {
      tempSeq = addOptimistic(trimmed);
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
        to_agent_id: ROOT_DADI_ID,
        content: trimmed,
      });
    } catch {
      markFailed(tempSeq);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void sendContent(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendContent(draft);
    }
  };

  return (
    <aside
      className={`widget-surface flex h-full min-h-0 flex-col overflow-hidden ${className ?? ""}`}
      data-agent-id={ROOT_DADI_ID}
      data-session-key={sessionKey}
      style={{ paddingBottom: keyboardInset > 0 ? keyboardInset : undefined }}
    >
      <div className="border-b border-dashed border-sage-line px-4 py-3">
        <span className="text-[11px] font-medium tracking-[2.5px] text-sage-deep">
          CHAT
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        onClick={dismissKeyboard}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <div className="flex flex-col gap-3">
          {chat.messages.map((msg) => (
            <MessageBubble
              key={msg.seq}
              message={msg}
              onRetry={() => void sendContent(msg.content, msg.seq)}
              onDismiss={() => removeMessage(msg.seq)}
            />
          ))}
          {chat.thinking && <ThinkingIndicator />}
        </div>
      </div>

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
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Message Dadi…"
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
    <div className="flex items-center gap-1 py-1" aria-label="Dadi is thinking">
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
