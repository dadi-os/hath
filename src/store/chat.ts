import type { DurableMessage, MessageAttachment, ThreadSummary } from "../shared/api/types";

export type { MessageAttachment };

export type ChatMessage = {
  /** Stable row id for an optimistic send; kept when the server seq arrives. */
  id?: string;
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
  /** Loaded from durable REST history; skip typewriter on open. */
  historical?: boolean;
};

export type Conversation = {
  agent_id: string;
  agent_name: string;
  last_message: string;
  last_at: string;
  from_user: boolean;
};

export type ChatOpen =
  | { kind: "list" }
  | { kind: "dadi" }
  | { kind: "agent"; agentId: string };

export type HistoryStatus = "idle" | "loading" | "ready" | "error";

type ChatState = {
  /** User-thread messages keyed by agent id. */
  threads: Record<string, ChatMessage[]>;
  /** Thread agents the human has talked to. */
  conversations: Conversation[];
  open: ChatOpen;
  historyStatus: HistoryStatus;
  historyError: string | null;
};

type Listener = (state: ChatState) => void;

let state: ChatState = {
  threads: {},
  conversations: [],
  open: { kind: "list" },
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

function hasConfirmedSeq(list: ChatMessage[], seq: number): boolean {
  return list.some((m) => m.seq === seq && m.seq >= 0 && !m.pending);
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

/** Open a user-thread for the given agent. */
export function openAgent(agentId: string): void {
  if (state.open.kind === "agent" && state.open.agentId === agentId) {
    return;
  }
  state = { ...state, open: { kind: "agent", agentId } };
  emit();
}

/** Open the Talk to Dadi composer (not an agent thread). */
export function openDadi(): void {
  if (state.open.kind === "dadi") {
    return;
  }
  state = { ...state, open: { kind: "dadi" } };
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

/**
 * On mesh disconnect: drop optimistic/pending/queued only.
 * Durable history stays — messages survive Dimaag restart.
 */
export function clearLiveChat(): void {
  const threads: Record<string, ChatMessage[]> = {};
  for (const [agentId, msgs] of Object.entries(state.threads)) {
    const kept = msgs.filter((m) => m.seq >= 0 && !m.pending && !m.queued && !m.failed);
    if (kept.length > 0) {
      threads[agentId] = kept;
    }
  }
  state = {
    ...state,
    threads,
    historyStatus: "idle",
    historyError: null,
  };
  emit();
}

/** Wipe threads and conversations (tests / full local reset). */
export function resetChatStore(): void {
  state = {
    threads: {},
    conversations: [],
    open: { kind: "list" },
    historyStatus: "idle",
    historyError: null,
  };
  emit();
}

/** Replace conversation list from GET /threads. */
export function seedConversations(threads: ThreadSummary[]): void {
  state = {
    ...state,
    conversations: sortConversations(threads.map((t) => ({ ...t }))),
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

/** Append if this live/optimistic seq is new; no-op on duplicate confirmed seq. */
export function appendMessage(agentId: string, msg: ChatMessage): void {
  const current = threadOf(agentId);
  if (msg.seq >= 0 && hasConfirmedSeq(current, msg.seq)) {
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
    id: crypto.randomUUID(),
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
  if (hasConfirmedSeq(current, realSeq)) {
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
 * Merge durable GET /agents/:id/messages into a thread.
 * Preserves in-flight optimistic rows; confirmed seqs are replaced by durable rows.
 */
export function hydrateThreadMessages(
  agentId: string,
  messages: DurableMessage[],
): void {
  const current = threadOf(agentId);
  const pending = current.filter(
    (m) => m.seq < 0 || m.pending || m.queued || m.failed,
  );
  const bySeq = new Map<number, ChatMessage>();
  for (const row of messages) {
    bySeq.set(row.seq, {
      id: row.id,
      seq: row.seq,
      from_user: row.from_agent_id === null,
      content: row.content,
      at: row.created_at,
      historical: true,
    });
  }
  for (const m of current) {
    if (m.seq >= 0 && !m.pending && !m.queued && !m.failed && !bySeq.has(m.seq)) {
      bySeq.set(m.seq, m);
    }
  }
  setThread(agentId, sortMessages([...bySeq.values(), ...pending]));
  emit();
}

/**
 * If a pending optimistic row has the same content, resolve it to realSeq.
 * Otherwise, if exactly one in-flight (non-queued) user pending exists — typical
 * after image describe rewrites content — resolve that. Else append.
 */
export function ingestLiveMessage(agentId: string, msg: ChatMessage): void {
  const current = threadOf(agentId);
  if (hasConfirmedSeq(current, msg.seq)) {
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
