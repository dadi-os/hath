import { invoke } from "@tauri-apps/api/core";

/** Contents of a provisioning bundle (base64 JSON). */
export type Credentials = {
  control_url: string;
  auth_key: string;
  node_name: string;
};

export class BundleDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleDecodeError";
  }
}

export async function loadCredentials(): Promise<Credentials | null> {
  return invoke<Credentials | null>("net_load_credentials");
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  await invoke("net_save_credentials", { credentials });
}

/**
 * Decode a base64 provisioning bundle into credentials.
 * Quiet failure message for paste/decode problems — auth failures surface later from Go.
 */
export function decodeProvisioningBundle(raw: string): Credentials {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new BundleDecodeError("Paste a setup code from Dadi.");
  }

  let jsonText: string;
  try {
    jsonText = atob(trimmed);
  } catch {
    throw new BundleDecodeError("Couldn't read that code. Check you copied the whole thing.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new BundleDecodeError("Couldn't read that code. Check you copied the whole thing.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new BundleDecodeError("Couldn't read that code. Check you copied the whole thing.");
  }

  const record = parsed as Record<string, unknown>;
  const control_url = asNonEmptyString(record.control_url);
  const auth_key = asNonEmptyString(record.auth_key);
  const node_name = asNonEmptyString(record.node_name);

  if (!control_url || !auth_key || !node_name) {
    throw new BundleDecodeError("Couldn't read that code. Check you copied the whole thing.");
  }

  return { control_url, auth_key, node_name };
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
