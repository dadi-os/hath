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
};

export type Conversation = {
  agent_id: string;
  agent_name: string;
  last_message: string;
  last_at: string;
  from_user: boolean;
};

/**
 * One optimistic outbound to root while routing. Survives list back-nav.
 * Cleared when any routed copy lands on a thread agent (or dismiss / timeout).
 */
export type PendingNewChatMessage = {
  /** Negative temp id, same space as thread optimistic seqs. */
  seq: number;
  content: string;
  at: string;
  pending?: boolean;
  failed?: boolean;
  /** Local-only while Dadi is busy; not POSTed until flush. */
  queued?: boolean;
};

/** Queued user→Dadi messages awaiting route_message onto a thread. */
export type PendingNewChat = {
  messages: PendingNewChatMessage[];
};

export type ChatOpen =
  | { kind: "list" }
  | { kind: "provisional" }
  | { kind: "agent"; agentId: string };

type ChatState = {
  /** User-thread messages keyed by agent id. */
  threads: Record<string, ChatMessage[]>;
  conversations: Conversation[];
  pendingNewChat: PendingNewChat | null;
  open: ChatOpen;
};

type Listener = (state: ChatState) => void;

let state: ChatState = {
  threads: {},
  conversations: [],
  pendingNewChat: null,
  open: { kind: "list" },
};
const listeners = new Set<Listener>();
let nextTempSeq = -1;

function emit(): void {
  for (const listener of listeners) {
    listener(state);
  }
}

/** Confirmed first; then in-flight pending; queued drafts last (oldest first). */
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

export function getChatState(): ChatState {
  return state;
}

export function subscribeChat(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openList(): void {
  if (state.open.kind === "list") {
    return;
  }
  state = { ...state, open: { kind: "list" } };
  emit();
}

export function openProvisional(): void {
  if (!state.pendingNewChat) {
    return;
  }
  if (state.open.kind === "provisional") {
    return;
  }
  state = { ...state, open: { kind: "provisional" } };
  emit();
}

export function openAgent(agentId: string): void {
  if (state.open.kind === "agent" && state.open.agentId === agentId) {
    return;
  }
  state = { ...state, open: { kind: "agent", agentId } };
  emit();
}

/** Drop live chat when the mesh drops — transcript dies with Dimaag; don't ghost it. */
export function clearLiveChat(): void {
  state = {
    threads: {},
    conversations: [],
    pendingNewChat: null,
    open: { kind: "list" },
  };
  emit();
}

/** Insert or refresh a conversation summary; list stays newest-first. */
export function upsertConversation(conv: Conversation): void {
  const rest = state.conversations.filter((c) => c.agent_id !== conv.agent_id);
  state = {
    ...state,
    conversations: sortConversations([conv, ...rest]),
  };
  emit();
}

/** Append if seq is new; no-op on duplicate. */
export function appendMessage(agentId: string, msg: ChatMessage): void {
  const current = threadOf(agentId);
  if (current.some((m) => m.seq === msg.seq)) {
    return;
  }
  setThread(agentId, sortMessages([...current, msg]));
  emit();
}

/** Insert an optimistic user message; returns its temporary (negative) seq. */
export function addOptimistic(
  agentId: string,
  content: string,
  opts?: { queued?: boolean },
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
): void {
  const current = threadOf(agentId);
  if (current.some((m) => m.seq === realSeq)) {
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
          ? { ...m, seq: realSeq, pending: false, failed: false }
          : m,
      ),
    ),
  );
  emit();
}

export function markFailed(agentId: string, tempSeq: number): void {
  setThread(
    agentId,
    threadOf(agentId).map((m) =>
      m.seq === tempSeq ? { ...m, pending: false, failed: true } : m,
    ),
  );
  emit();
}

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

/** Append a message to Dadi; `queued` stays local-only until flush. */
export function enqueuePendingNewChat(
  content: string,
  opts?: { queued?: boolean },
): number {
  const queued = Boolean(opts?.queued);
  const msg: PendingNewChatMessage = {
    seq: nextPendingSeq(),
    content,
    at: new Date().toISOString(),
    pending: true,
    queued: queued || undefined,
  };
  const existing = state.pendingNewChat;
  state = {
    ...state,
    pendingNewChat: {
      messages: existing ? [...existing.messages, msg] : [msg],
    },
    open: { kind: "provisional" },
  };
  emit();
  return msg.seq;
}

export function clearPendingNewChat(): void {
  if (state.pendingNewChat === null) {
    return;
  }
  const open: ChatOpen =
    state.open.kind === "provisional" ? { kind: "list" } : state.open;
  state = { ...state, pendingNewChat: null, open };
  emit();
}

/** Mark every still-pending provisional message failed (timeout / hard fail). */
export function markPendingNewChatFailed(): void {
  const pending = state.pendingNewChat;
  if (!pending) {
    return;
  }
  // Local queue drafts were never POSTed — leave them alone.
  const messages = pending.messages.map((m) =>
    m.failed || m.queued ? m : { ...m, pending: false, failed: true },
  );
  if (messages.every((m, i) => m === pending.messages[i])) {
    return;
  }
  state = { ...state, pendingNewChat: { messages } };
  emit();
}

export function markPendingNewChatMessageFailed(seq: number): void {
  const pending = state.pendingNewChat;
  if (!pending) {
    return;
  }
  state = {
    ...state,
    pendingNewChat: {
      messages: pending.messages.map((m) =>
        m.seq === seq ? { ...m, pending: false, failed: true } : m,
      ),
    },
  };
  emit();
}

export function markPendingNewChatMessagePending(seq: number): void {
  const pending = state.pendingNewChat;
  if (!pending) {
    return;
  }
  state = {
    ...state,
    pendingNewChat: {
      messages: pending.messages.map((m) =>
        m.seq === seq
          ? { ...m, pending: true, failed: false, queued: undefined }
          : m,
      ),
    },
  };
  emit();
}

/** Drop one provisional message (cancel a local queue draft). */
export function removePendingNewChatMessage(seq: number): void {
  const pending = state.pendingNewChat;
  if (!pending) {
    return;
  }
  const messages = pending.messages.filter((m) => m.seq !== seq);
  if (messages.length === pending.messages.length) {
    return;
  }
  if (messages.length === 0) {
    const open: ChatOpen =
      state.open.kind === "provisional" ? { kind: "list" } : state.open;
    state = { ...state, pendingNewChat: null, open };
    emit();
    return;
  }
  state = { ...state, pendingNewChat: { messages } };
  emit();
}

/** Queued provisional messages, oldest first. */
export function listQueuedPendingNewChat(): PendingNewChatMessage[] {
  return (state.pendingNewChat?.messages ?? []).filter((m) => m.queued);
}

function nextPendingSeq(): number {
  const seq = nextTempSeq;
  nextTempSeq -= 1;
  return seq;
}

/**
 * When any user-thread activity lands on a non-root agent while a provisional
 * chat is open, attach it. Exact content match is preferred by callers but not
 * required — root may paraphrase, or the first signal may be the thread's reply.
 * Local queue drafts move onto that agent so they can still be cancelled or flushed.
 */
export function tryBindPendingNewChat(agentId: string): boolean {
  const pending = state.pendingNewChat;
  if (!pending) {
    return false;
  }
  if (pending.messages.every((m) => m.failed)) {
    return false;
  }
  const carry = pending.messages.filter((m) => m.queued && !m.failed);
  const open: ChatOpen =
    state.open.kind === "provisional"
      ? { kind: "agent", agentId }
      : state.open;
  state = { ...state, pendingNewChat: null, open };
  if (carry.length > 0) {
    const extras: ChatMessage[] = carry.map((m) => ({
      seq: m.seq,
      from_user: true,
      content: m.content,
      at: m.at,
      pending: true,
      queued: true,
    }));
    setThread(agentId, sortMessages([...threadOf(agentId), ...extras]));
  }
  emit();
  return true;
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
 * If a pending optimistic row has the same content, resolve it to realSeq.
 * Otherwise append. Used by the SSE message handler.
 */
export function ingestLiveMessage(agentId: string, msg: ChatMessage): void {
  const current = threadOf(agentId);
  if (current.some((m) => m.seq === msg.seq)) {
    return;
  }
  if (msg.from_user) {
    const pending = current.find(
      (m) => m.pending && m.from_user && m.content === msg.content,
    );
    if (pending) {
      resolveOptimistic(agentId, pending.seq, msg.seq);
      return;
    }
  }
  appendMessage(agentId, msg);
}
