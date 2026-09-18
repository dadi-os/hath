import type { LogRecord, MessageAttachment } from "../shared/api/types";

export type { MessageAttachment };

export type ChatMessage = {
  /** Server sequence; optimistic messages use negative values. */
  seq: number;
  /** True when from_agent_id === null (human → agent). */
  from_user: boolean;
  content: string;
  at: string;
  /** Optimistic, not yet confirmed by the server. */
  pending?: boolean;
  /** Send failed; eligible for retry or dismiss. */
  failed?: boolean;
  /**
   * Waiting locally because the conversation lane is busy. Not POSTed yet — can cancel.
   * Rendered after settled messages as a draft (reasoning-busy does not queue).
   */
  queued?: boolean;
  /** Kept only while queued/pending so retry can re-POST; cleared once server content lands. */
  attachments?: MessageAttachment[];
  /**
   * Original user text for POST when `content` is a local display string
   * (e.g. with `[Image: …]` placeholders before describe-patch).
   */
  outboundText?: string;
  /** Loaded from agent_logs; skip typewriter and never collide with live seqs. */
  historical?: boolean;
};

export type Conversation = {
  agent_id: string;
  agent_name: string;
  last_message: string;
  last_at: string;
  from_user: boolean;
};

export type ChatOpen = { kind: "list" } | { kind: "agent"; agentId: string };

export type HistoryStatus = "idle" | "loading" | "ready" | "error";

type ChatState = {
  /** User-thread messages keyed by agent id, including root (Dadi). */
  threads: Record<string, ChatMessage[]>;
  /** Thread agents the human has talked to. Excludes root — Dadi is pinned separately. */
  conversations: Conversation[];
  open: ChatOpen;
  /** Root agent id once known; Talk to Dadi opens this thread. */
  rootId: string | null;
  historyStatus: HistoryStatus;
  historyError: string | null;
};

type Listener = (state: ChatState) => void;

let state: ChatState = {
  threads: {},
  conversations: [],
  open: { kind: "list" },
  rootId: null,
  historyStatus: "idle",
  historyError: null,
};
const listeners = new Set<Listener>();
let nextTempSeq = -1;

function emit(): void {
  for (const listener of listeners) {
    listener(state);
  }
}

/** Confirmed first (by time, then seq); then in-flight pending; queued drafts last. */
function sortMessages(list: ChatMessage[]): ChatMessage[] {
  return [...list].sort((a, b) => {
    const rank = (m: ChatMessage) => {
      if (m.queued) {
        return 2;
      }
      if (m.seq < 0) {
        return 1;
      }
      return 0;
    };
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) {
      return ra - rb;
    }
    if (ra === 0) {
      const byTime = a.at.localeCompare(b.at);
      if (byTime !== 0) {
        return byTime;
      }
      return a.seq - b.seq;
    }
    if (a.seq < 0 && b.seq < 0) {
      return b.seq - a.seq;
    }
    return a.seq - b.seq;
  });
}

function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => b.last_at.localeCompare(a.last_at));
}

function threadOf(agentId: string): ChatMessage[] {
  return state.threads[agentId] ?? [];
}

function setThread(agentId: string, messages: ChatMessage[]): void {
  state = {
    ...state,
    threads: { ...state.threads, [agentId]: messages },
  };
}

function hasLiveSeq(list: ChatMessage[], seq: number): boolean {
  return list.some((m) => !m.historical && m.seq === seq);
}

function hasHistoricalTwin(list: ChatMessage[], msg: ChatMessage): boolean {
  return list.some(
    (m) =>
      m.historical === true &&
      m.seq === msg.seq &&
      m.at === msg.at &&
      m.content === msg.content,
  );
}

/** Snapshot of chat store state (threads, list, open view, history). */
export function getChatState(): ChatState {
  return state;
}

/** Subscribe to chat store updates; returns unsubscribe. */
export function subscribeChat(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Show the conversation list. */
export function openList(): void {
  if (state.open.kind === "list") {
    return;
  }
  state = { ...state, open: { kind: "list" } };
  emit();
}

/** Open a user-thread for the given agent (root = Talk to Dadi). */
export function openAgent(agentId: string): void {
  if (state.open.kind === "agent" && state.open.agentId === agentId) {
    return;
  }
  state = { ...state, open: { kind: "agent", agentId } };
  emit();
}

/** Open the Dadi (root) thread when the root id is known. */
export function openDadi(): boolean {
  if (!state.rootId) {
    return false;
  }
  openAgent(state.rootId);
  return true;
}

/** Remember the root agent id used by Talk to Dadi. */
export function setChatRoot(rootId: string | null): void {
  if (state.rootId === rootId) {
    return;
  }
  state = { ...state, rootId };
  emit();
}

/** Record history fetch progress. Failed loads keep any threads already in memory. */
export function setHistoryState(
  status: HistoryStatus,
  error: string | null = null,
): void {
  if (state.historyStatus === status && state.historyError === error) {
    return;
  }
  state = { ...state, historyStatus: status, historyError: error };
  emit();
}

/** Drop live chat when the mesh drops — transcript dies with Dimaag; don't ghost it. */
export function clearLiveChat(): void {
  state = {
    threads: {},
    conversations: [],
    open: { kind: "list" },
    rootId: state.rootId,
    historyStatus: "idle",
    historyError: null,
  };
  emit();
}

/** Insert or refresh a conversation summary if `last_at` is newer than what we have. */
export function upsertConversation(conv: Conversation): void {
  const existing = state.conversations.find((c) => c.agent_id === conv.agent_id);
  if (existing && existing.last_at > conv.last_at) {
    return;
  }
  const rest = state.conversations.filter((c) => c.agent_id !== conv.agent_id);
  const next: Conversation = {
    ...conv,
    agent_name:
      conv.agent_name !== conv.agent_id
        ? conv.agent_name
        : (existing?.agent_name ?? conv.agent_name),
  };
  state = {
    ...state,
    conversations: sortConversations([next, ...rest]),
  };
  emit();
}

/** Append if this live/optimistic seq is new; no-op on duplicate live seq. */
export function appendMessage(agentId: string, msg: ChatMessage): void {
  const current = threadOf(agentId);
  if (msg.historical) {
    if (hasHistoricalTwin(current, msg)) {
      return;
    }
  } else if (hasLiveSeq(current, msg.seq)) {
    return;
  }
  setThread(agentId, sortMessages([...current, msg]));
  emit();
}

/** Local bubble text before Dimaag patches image descriptions into content. */
export function formatOutboundContent(
  text: string,
  attachments?: MessageAttachment[],
): string {
  const trimmed = text.trim();
  const parts: string[] = [];
  if (trimmed) {
    parts.push(trimmed);
  }
  for (const att of attachments ?? []) {
    const name = att.filename?.trim();
    if (att.media_type.startsWith("image/")) {
      parts.push(name ? `[Image: ${name}]` : "[Image]");
    } else {
      parts.push(name ? `[File: ${name}]` : "[File]");
    }
  }
  return parts.join("\n");
}

/** Insert an optimistic user message; returns its temporary (negative) seq. */
export function addOptimistic(
  agentId: string,
  content: string,
  opts?: {
    queued?: boolean;
    attachments?: MessageAttachment[];
    outboundText?: string;
  },
): number {
  const seq = nextTempSeq;
  nextTempSeq -= 1;
  const queued = Boolean(opts?.queued);
  const msg: ChatMessage = {
    seq,
    from_user: true,
    content,
    at: new Date().toISOString(),
    pending: true,
    queued: queued || undefined,
    attachments: opts?.attachments,
    outboundText: opts?.outboundText,
  };
  setThread(agentId, sortMessages([...threadOf(agentId), msg]));
  emit();
  return seq;
}

/** Promote a temp seq to the server seq and clear pending. */
export function resolveOptimistic(
  agentId: string,
  tempSeq: number,
  realSeq: number,
  content?: string,
): void {
  const current = threadOf(agentId);
  if (hasLiveSeq(current, realSeq)) {
    setThread(
      agentId,
      sortMessages(current.filter((m) => m.seq !== tempSeq)),
    );
    emit();
    return;
  }
  setThread(
    agentId,
    sortMessages(
      current.map((m) =>
        m.seq === tempSeq
          ? {
              ...m,
              seq: realSeq,
              pending: false,
              failed: false,
              content: content ?? m.content,
              attachments: undefined,
              outboundText: undefined,
            }
          : m,
      ),
    ),
  );
  emit();
}

/** Mark an optimistic message as failed (eligible for retry/dismiss). */
export function markFailed(agentId: string, tempSeq: number): void {
  setThread(
    agentId,
    threadOf(agentId).map((m) =>
      m.seq === tempSeq ? { ...m, pending: false, failed: true } : m,
    ),
  );
  emit();
}

/** Remove a message from a thread by seq (cancel draft or dismiss failed). */
export function removeMessage(agentId: string, seq: number): void {
  setThread(
    agentId,
    threadOf(agentId).filter((m) => m.seq !== seq),
  );
  emit();
}

/** Clear failed/queued and set pending again before a retry POST. */
export function markPending(agentId: string, tempSeq: number): void {
  setThread(
    agentId,
    threadOf(agentId).map((m) =>
      m.seq === tempSeq
        ? { ...m, pending: true, failed: false, queued: undefined }
        : m,
    ),
  );
  emit();
}

/** Queued (not yet POSTed) messages for an agent, oldest first. */
export function listQueuedThread(agentId: string): ChatMessage[] {
  return threadOf(agentId).filter((m) => m.queued && m.from_user);
}

/**
 * User-thread filter: the human is null on one side.
 * Agent↔agent traffic stays out of the chat sidebar.
 */
export function isUserThreadMessage(
  fromAgentId: string | null,
  toAgentId: string | null,
): boolean {
  return fromAgentId === null || toAgentId === null;
}

/**
 * Conversation key for a user-thread message: the non-null agent.
 * User → agent uses the recipient; agent → user uses the sender.
 */
export function threadAgentId(
  fromAgentId: string | null,
  toAgentId: string | null,
): string | null {
  if (fromAgentId === null && toAgentId !== null) {
    return toAgentId;
  }
  if (toAgentId === null && fromAgentId !== null) {
    return fromAgentId;
  }
  return null;
}

/**
 * Merge a durable agent_logs message into a thread.
 * Historical rows never collide with live seqs from a later Dimaag process.
 * Returns whether the thread changed. Pass `silent` to batch emits (hydrate).
 */
export function importHistoryMessage(
  agentId: string,
  msg: ChatMessage,
  silent = false,
): boolean {
  const current = threadOf(agentId);
  if (hasHistoricalTwin(current, msg)) {
    return false;
  }
  if (
    current.some(
      (m) =>
        !m.historical &&
        m.seq >= 0 &&
        !m.pending &&
        m.seq === msg.seq &&
        m.content === msg.content &&
        m.from_user === msg.from_user,
    )
  ) {
    return false;
  }
  setThread(agentId, sortMessages([...current, { ...msg, historical: true }]));
  if (!silent) {
    emit();
  }
  return true;
}

/**
 * Parse a Dimaag message log into a user-thread row.
 * Returns null for agent↔agent traffic or a payload missing seq/content.
 */
export function userThreadFromLog(log: LogRecord): {
  agent_id: string;
  message: ChatMessage;
} | null {
  if (log.event !== "message") {
    return null;
  }
  const from = log.payload.from_agent_id;
  const to = log.payload.to_agent_id;
  const content = log.payload.content;
  const seq = log.payload.seq;
  if (from !== null && typeof from !== "string") {
    return null;
  }
  if (to !== null && typeof to !== "string") {
    return null;
  }
  if (typeof content !== "string" || typeof seq !== "number" || !Number.isInteger(seq)) {
    return null;
  }
  if (!isUserThreadMessage(from, to)) {
    return null;
  }
  const agentId = threadAgentId(from, to);
  if (!agentId) {
    return null;
  }
  return {
    agent_id: agentId,
    message: {
      seq,
      from_user: from === null,
      content,
      at: log.created_at,
      historical: true,
    },
  };
}

/**
 * Load user-thread history from message logs. Root (Dadi) fills `threads[rootId]`
 * but is kept out of the conversation list — Talk to Dadi is the entry.
 */
export function hydrateFromLogs(
  logs: LogRecord[],
  names: Record<string, string>,
  rootId: string | null,
): void {
  let changed = false;
  for (const log of logs) {
    const parsed = userThreadFromLog(log);
    if (!parsed) {
      continue;
    }
    if (importHistoryMessage(parsed.agent_id, parsed.message, true)) {
      changed = true;
    }
    if (rootId !== null && parsed.agent_id === rootId) {
      continue;
    }
    const existing = state.conversations.find(
      (c) => c.agent_id === parsed.agent_id,
    );
    if (existing && existing.last_at > parsed.message.at) {
      continue;
    }
    const rest = state.conversations.filter(
      (c) => c.agent_id !== parsed.agent_id,
    );
    const existingName = existing?.agent_name;
    const named = names[parsed.agent_id];
    state = {
      ...state,
      conversations: sortConversations([
        {
          agent_id: parsed.agent_id,
          agent_name: named ?? existingName ?? parsed.agent_id,
          last_message: parsed.message.content,
          last_at: parsed.message.at,
          from_user: parsed.message.from_user,
        },
        ...rest,
      ]),
    };
    changed = true;
  }
  if (changed) {
    emit();
  }
}

/**
 * If a pending optimistic row has the same content, resolve it to realSeq.
 * Otherwise, if exactly one in-flight (non-queued) user pending exists — typical
 * after image describe rewrites content — resolve that. Else append.
 */
export function ingestLiveMessage(agentId: string, msg: ChatMessage): void {
  const current = threadOf(agentId);
  if (hasLiveSeq(current, msg.seq)) {
    return;
  }
  if (msg.from_user) {
    const exact = current.find(
      (m) =>
        m.pending && m.from_user && !m.queued && m.content === msg.content,
    );
    if (exact) {
      resolveOptimistic(agentId, exact.seq, msg.seq, msg.content);
      return;
    }
    const inFlight = current.filter(
      (m) => m.pending && m.from_user && !m.queued,
    );
    if (inFlight.length === 1) {
      resolveOptimistic(agentId, inFlight[0]!.seq, msg.seq, msg.content);
      return;
    }
  }
  appendMessage(agentId, msg);
}
