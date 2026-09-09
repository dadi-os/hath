import { useSyncExternalStore } from "react";
import { transport } from "../shared/api";

/** Mesh-only provisioning surface; absent on BrowserTransport. */
type ProvisioningTransport = {
  needsProvisioningKey(): boolean;
  onProvisioningNeeded(listener: (needed: boolean) => void): () => void;
};

function asProvisioning(t: unknown): ProvisioningTransport | null {
  if (
    t &&
    typeof t === "object" &&
    "needsProvisioningKey" in t &&
    typeof (t as ProvisioningTransport).needsProvisioningKey === "function" &&
    typeof (t as ProvisioningTransport).onProvisioningNeeded === "function"
  ) {
    return t as ProvisioningTransport;
  }
  return null;
}

function subscribeProvisioningNeeded(onStoreChange: () => void): () => void {
  const api = asProvisioning(transport);
  if (!api) {
    return () => {};
  }
  return api.onProvisioningNeeded(() => onStoreChange());
}

function getNeedsProvisioning(): boolean {
  return asProvisioning(transport)?.needsProvisioningKey() ?? false;
}

/** Whether the mesh transport needs a provision code (Tauri onboarding). */
export function useNeedsProvisioning(): boolean {
  return useSyncExternalStore(
    subscribeProvisioningNeeded,
    getNeedsProvisioning,
    getNeedsProvisioning,
  );
}
