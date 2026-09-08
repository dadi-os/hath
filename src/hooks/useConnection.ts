import { useSyncExternalStore } from "react";
import type { ConnectionState } from "../shared/api/transport";
import {
  connectTransport,
  disconnectTransport,
  getConnectionState,
  subscribeConnection,
} from "../store/connection";

export function useConnection(): {
  state: ConnectionState;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
} {
  const state = useSyncExternalStore(
    subscribeConnection,
    getConnectionState,
    getConnectionState,
  );

  return {
    state,
    connect: connectTransport,
    disconnect: disconnectTransport,
  };
}
