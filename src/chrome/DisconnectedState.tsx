import { useCallback, useState, useSyncExternalStore, type FormEvent } from "react";
import { motion } from "motion/react";
import {
  BundleDecodeError,
  decodeProvisioningBundle,
  saveCredentials,
  type Credentials,
} from "../shared/api/credentials";
import { transport } from "../shared/api";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";
import { QrScanner } from "./QrScanner";

/** Tsnet-only provisioning surface; absent on BrowserTransport. */
type ProvisioningTransport = {
  needsProvisioningKey(): boolean;
  onProvisioningNeeded(listener: (needed: boolean) => void): () => void;
  connect(override?: Credentials): Promise<void>;
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

function subscribeProvisioning(onStoreChange: () => void): () => void {
  const api = asProvisioning(transport);
  if (!api) {
    return () => {};
  }
  return api.onProvisioningNeeded(() => onStoreChange());
}

function getNeedsProvisioning(): boolean {
  return asProvisioning(transport)?.needsProvisioningKey() ?? false;
}

/**
 * Shown while ConnectionState is disconnected. Camera-first setup when the
 * tsnet transport signals missing credentials.
 */
export function DisconnectedState() {
  const needsProvisioning = useSyncExternalStore(
    subscribeProvisioning,
    getNeedsProvisioning,
    getNeedsProvisioning,
  );
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Default to camera; paste is the fallback surface. */
  const [mode, setMode] = useState<"camera" | "paste">("camera");

  const joinWithCode = useCallback(async (raw: string) => {
    const api = asProvisioning(transport);
    if (!api) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const credentials = decodeProvisioningBundle(raw);
      await api.connect(credentials);
      await saveCredentials(credentials);
      setCode("");
    } catch (err) {
      if (err instanceof BundleDecodeError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await joinWithCode(code);
  };

  const onScanDecode = useCallback(
    (text: string) => {
      void joinWithCode(text);
    },
    [joinWithCode],
  );

  if (needsProvisioning) {
    return (
      <motion.div
        className="flex h-full min-h-0 flex-col items-center overflow-hidden px-5 py-6 sm:px-8"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: SLOW_S, ease: EASE }}
      >
        <div className="mb-5 flex flex-col items-center gap-2">
          <span className="font-gujarati text-[44px] leading-none text-sage-text">
            દાદી
          </span>
          <span className="text-[11px] font-medium tracking-[2.5px] text-ink-faint">
            SETUP
          </span>
          <p className="max-w-sm text-center text-[14px] leading-relaxed text-ink-muted">
            Scan the setup QR from Add Device on the box.
          </p>
        </div>

        <div className="glass-sheet flex min-h-0 w-full max-w-md flex-1 flex-col overflow-hidden rounded-[var(--radius-window)] p-4 shadow-[var(--shadow-deep)]">
          {mode === "camera" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {busy ? (
                <div className="flex flex-1 items-center justify-center">
                  <p className="text-[12px] font-medium tracking-[2px] text-sage-deep">
                    JOINING…
                  </p>
                </div>
              ) : (
                <QrScanner
                  fill
                  onDecode={onScanDecode}
                  onCancel={() => {
                    setMode("paste");
                    setError(null);
                  }}
                />
              )}
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                void onSubmit(e);
              }}
              className="flex flex-1 flex-col gap-4"
            >
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium tracking-[2px] text-sage-deep">
                  SETUP CODE
                </span>
                <textarea
                  autoComplete="off"
                  spellCheck={false}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Paste the code from Dadi"
                  rows={4}
                  className="w-full resize-none rounded-[var(--radius)] border border-sage-line bg-bone/50 px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-sage"
                  disabled={busy}
                />
              </label>
              {error ? (
                <p className="text-center text-[13px] text-[#b56b5c]">{error}</p>
              ) : null}
              <div className="mt-auto flex items-center justify-between gap-4 pt-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setMode("camera");
                    setError(null);
                  }}
                  className="text-[12px] font-medium tracking-[2px] text-sage-deep disabled:opacity-50"
                >
                  USE CAMERA
                </button>
                <button
                  type="submit"
                  disabled={busy || !code.trim()}
                  className="rounded-[var(--radius)] border border-sage-line bg-sage-fill/50 px-4 py-2 text-[12px] font-medium tracking-[2px] text-sage-deep disabled:opacity-50"
                >
                  {busy ? "JOINING…" : "JOIN"}
                </button>
              </div>
            </form>
          )}

          {mode === "camera" && error ? (
            <p className="mt-3 text-center text-[13px] text-[#b56b5c]">{error}</p>
          ) : null}
        </div>
      </motion.div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center px-8">
      <p className="max-w-sm text-center text-[15px] leading-relaxed text-ink-muted">
        Dadi is unreachable. Retrying…
      </p>
    </div>
  );
}
