import type { ConnectionState } from "../shared/api/transport";
import { NotProvisionedError } from "../shared/api/tsnet-transport";
import { transport } from "../shared/api";

type Listener = (state: ConnectionState) => void;

let state: ConnectionState = transport.connectionState();
const listeners = new Set<Listener>();

transport.onConnectionChange((next) => {
  state = next;
  for (const listener of listeners) {
    listener(state);
  }
});

export function getConnectionState(): ConnectionState {
  return state;
}

export function subscribeConnection(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function connectTransport(): Promise<void> {
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
  await transport.disconnect();
}
