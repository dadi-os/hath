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

type ChatState = {
  messages: ChatMessage[];
  thinking: boolean;
};

type Listener = (state: ChatState) => void;

let state: ChatState = { messages: [], thinking: false };
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
export function seedMessages(list: ChatMessage[]): void {
  const bySeq = new Map<number, ChatMessage>();
  for (const msg of list) {
    bySeq.set(msg.seq, msg);
  }
  for (const msg of state.messages) {
    if (msg.seq < 0) {
      continue;
    }
    if (!bySeq.has(msg.seq)) {
      bySeq.set(msg.seq, msg);
    }
  }
  const pending = state.messages.filter((m) => m.seq < 0);
  state = {
    ...state,
    messages: sortMessages([...bySeq.values(), ...pending]),
  };
  emit();
}

/** Append if seq is new; no-op on duplicate. */
export function appendMessage(msg: ChatMessage): void {
  if (state.messages.some((m) => m.seq === msg.seq)) {
    return;
  }
  state = {
    ...state,
    messages: sortMessages([...state.messages, msg]),
  };
  emit();
}

/** Insert an optimistic user message; returns its temporary (negative) seq. */
export function addOptimistic(content: string): number {
  const seq = nextTempSeq;
  nextTempSeq -= 1;
  const msg: ChatMessage = {
    seq,
    from_user: true,
    content,
    at: new Date().toISOString(),
    pending: true,
  };
  state = {
    ...state,
    messages: sortMessages([...state.messages, msg]),
  };
  emit();
  return seq;
}

/** Promote a temp seq to the server seq and clear pending. */
export function resolveOptimistic(tempSeq: number, realSeq: number): void {
  if (state.messages.some((m) => m.seq === realSeq)) {
    state = {
      ...state,
      messages: sortMessages(state.messages.filter((m) => m.seq !== tempSeq)),
    };
    emit();
    return;
  }
  state = {
    ...state,
    messages: sortMessages(
      state.messages.map((m) =>
        m.seq === tempSeq
          ? { ...m, seq: realSeq, pending: false, failed: false }
          : m,
      ),
    ),
  };
  emit();
}

export function markFailed(tempSeq: number): void {
  state = {
    ...state,
    messages: state.messages.map((m) =>
      m.seq === tempSeq ? { ...m, pending: false, failed: true } : m,
    ),
  };
  emit();
}

export function removeMessage(seq: number): void {
  state = {
    ...state,
    messages: state.messages.filter((m) => m.seq !== seq),
  };
  emit();
}

/** Clear failed and set pending again before a retry POST. */
export function markPending(tempSeq: number): void {
  state = {
    ...state,
    messages: state.messages.map((m) =>
      m.seq === tempSeq ? { ...m, pending: true, failed: false } : m,
    ),
  };
  emit();
}

export function setThinking(thinking: boolean): void {
  if (state.thinking === thinking) {
    return;
  }
  state = { ...state, thinking };
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
export function ingestLiveMessage(msg: ChatMessage): void {
  if (state.messages.some((m) => m.seq === msg.seq)) {
    return;
  }
  if (msg.from_user) {
    const pending = state.messages.find(
      (m) => m.pending && m.from_user && m.content === msg.content,
    );
    if (pending) {
      resolveOptimistic(pending.seq, msg.seq);
      return;
    }
  }
  appendMessage(msg);
}
