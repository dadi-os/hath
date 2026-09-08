import type { ConnectionState } from "../shared/api/transport";
import { NotProvisionedError } from "../shared/api/errors";
import { transport } from "../shared/api";

type Listener = (state: ConnectionState) => void;

let state: ConnectionState = "disconnected";
const listeners = new Set<Listener>();
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) {
    return;
  }
  subscribed = true;
  state = transport.connectionState();
  transport.onConnectionChange((next) => {
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
  });
}

export function getConnectionState(): ConnectionState {
  ensureSubscribed();
  return state;
}

export function subscribeConnection(listener: Listener): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function connectTransport(): Promise<void> {
  ensureSubscribed();
  try {
    await transport.connect();
  } catch (err) {
    if (err instanceof NotProvisionedError) {
      return;
    }
    throw err;
  }
}

export async function disconnectTransport(): Promise<void> {
  ensureSubscribed();
  await transport.disconnect();
}
