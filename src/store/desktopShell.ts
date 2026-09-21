/** Desktop shell actions from the tray / app menu into the React UI. */

export type DesktopShellAction =
  | { type: "show_window" }
  | { type: "provision" }
  | { type: "check_update" }
  | { type: "install_update" }
  | { type: "leave_mesh" }
  | { type: "navigate"; path: string }
  | { type: "open_agent"; agentId: string }
  | { type: "quit" };

type Listener = (action: DesktopShellAction) => void;

const listeners = new Set<Listener>();

/** Subscribe to tray / menu actions. Returns unsubscribe. */
export function subscribeDesktopShell(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Dispatch a desktop shell action to all listeners. */
export function dispatchDesktopShell(action: DesktopShellAction): void {
  for (const listener of listeners) {
    listener(action);
  }
}
