import type { ConnectionState } from "../shared/api/transport";
import { transport, usingTsnet } from "../shared/api";

type Listener = (state: ConnectionState) => void;

let state: ConnectionState = "disconnected";
const listeners = new Set<Listener>();
let subscribed = false;
let bootstrapped = false;

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

/**
 * On launch: detect provisioning only. Do not auto-start dadiMesh —
 * join is explicit (onboarding or power overlay).
 */
export async function bootstrapMesh(): Promise<void> {
  ensureSubscribed();
  if (bootstrapped) {
    return;
  }
  bootstrapped = true;
  if (!usingTsnet) {
    await connectTransport();
    return;
  }
  const mesh = transport as {
    prepareProvisioning?: () => Promise<void>;
  };
  if (typeof mesh.prepareProvisioning === "function") {
    await mesh.prepareProvisioning();
  }
}

export async function connectTransport(): Promise<void> {
  ensureSubscribed();
  const { NotProvisionedError } = await import("../shared/api/errors");
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
