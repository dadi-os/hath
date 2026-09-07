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
};

export type Conversation = {
  agent_id: string;
  agent_name: string;
  last_message: string;
  last_at: string;
  from_user: boolean;
};

/** Provisional new-chat row — not yet attached to any thread. */
export type PendingNewChat = {
  content: string;
  at: string;
  failed?: boolean;
};

type ChatState = {
  /** User-thread messages keyed by agent id. */
  threads: Record<string, ChatMessage[]>;
  conversations: Conversation[];
  pendingNewChat: PendingNewChat | null;
};

type Listener = (state: ChatState) => void;

let state: ChatState = {
  threads: {},
  conversations: [],
  pendingNewChat: null,
};
const listeners = new Set<Listener>();
let nextTempSeq = -1;

function emit(): void {
  for (const listener of listeners) {
    listener(state);
  }
}

/** Confirmed by seq ascending; pending/failed after, oldest temp first. */
function sortMessages(list: ChatMessage[]): ChatMessage[] {
  return [...list].sort((a, b) => {
    const aTemp = a.seq < 0;
    const bTemp = b.seq < 0;
    if (aTemp !== bTemp) {
      return aTemp ? 1 : -1;
    }
    if (aTemp) {
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

/**
 * Replace the confirmed thread. Pending/failed optimistic rows are kept.
 * Live rows whose seq is absent from the seed are preserved (race with fetch).
 */
export function seedThread(agentId: string, list: ChatMessage[]): void {
  const bySeq = new Map<number, ChatMessage>();
  for (const msg of list) {
    bySeq.set(msg.seq, msg);
  }
  for (const msg of threadOf(agentId)) {
    if (msg.seq < 0) {
      continue;
    }
    if (!bySeq.has(msg.seq)) {
      bySeq.set(msg.seq, msg);
    }
  }
  const pending = threadOf(agentId).filter((m) => m.seq < 0);
  setThread(agentId, sortMessages([...bySeq.values(), ...pending]));
  emit();
}

/**
 * Replace the conversation list from GET /logs. Keeps any live entry whose
 * last_at is newer than the seed (SSE race).
 */
export function seedConversations(list: Conversation[]): void {
  const byId = new Map(list.map((c) => [c.agent_id, c]));
  for (const existing of state.conversations) {
    const seeded = byId.get(existing.agent_id);
    if (!seeded) {
      byId.set(existing.agent_id, existing);
      continue;
    }
    if (existing.last_at > seeded.last_at) {
      byId.set(existing.agent_id, existing);
    }
  }
  state = {
    ...state,
    conversations: sortConversations([...byId.values()]),
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
export function addOptimistic(agentId: string, content: string): number {
  const seq = nextTempSeq;
  nextTempSeq -= 1;
  const msg: ChatMessage = {
    seq,
    from_user: true,
    content,
    at: new Date().toISOString(),
    pending: true,
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

/** Clear failed and set pending again before a retry POST. */
export function markPending(agentId: string, tempSeq: number): void {
  setThread(
    agentId,
    threadOf(agentId).map((m) =>
      m.seq === tempSeq ? { ...m, pending: true, failed: false } : m,
    ),
  );
  emit();
}

export function setPendingNewChat(pending: PendingNewChat): void {
  state = { ...state, pendingNewChat: pending };
  emit();
}

export function clearPendingNewChat(): void {
  if (state.pendingNewChat === null) {
    return;
  }
  state = { ...state, pendingNewChat: null };
  emit();
}

export function markPendingNewChatFailed(): void {
  if (!state.pendingNewChat || state.pendingNewChat.failed) {
    return;
  }
  state = {
    ...state,
    pendingNewChat: { ...state.pendingNewChat, failed: true },
  };
  emit();
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
