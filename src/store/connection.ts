import type { ConnectionState } from "../api/transport";
import { AuthKeyRequiredError } from "../api/tsnet-transport";
import { transport } from "../api";

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
    // Auth-key prompt is shown via DisconnectedState; swallow so auto-connect
    // on launch does not surface an unhandled rejection.
    if (err instanceof AuthKeyRequiredError) {
      return;
    }
    throw err;
  }
}

export async function disconnectTransport(): Promise<void> {
  await transport.disconnect();
}
