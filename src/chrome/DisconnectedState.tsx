import { useCallback, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  BundleDecodeError,
  decodeProvisioningBundle,
  saveCredentials,
  type Credentials,
} from "../shared/api/credentials";
import { transport } from "../shared/api";
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
 * Shown while ConnectionState is disconnected. Setup UI only when the tsnet
 * transport signals missing credentials — never by reading the credential store.
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
  const [scanning, setScanning] = useState(false);

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
      setScanning(false);
    } catch (err) {
      if (err instanceof BundleDecodeError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setScanning(false);
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
      setScanning(false);
      void joinWithCode(text);
    },
    [joinWithCode],
  );

  if (needsProvisioning) {
    if (scanning) {
      return (
        <div className="flex h-full items-center justify-center px-8">
          <QrScanner
            onDecode={onScanDecode}
            onCancel={() => {
              setScanning(false);
              setError(null);
            }}
          />
        </div>
      );
    }

    return (
      <div className="flex h-full items-center justify-center px-8">
        <form
          onSubmit={(e) => {
            void onSubmit(e);
          }}
          className="flex w-full max-w-sm flex-col items-center gap-6"
        >
          <div className="flex items-baseline gap-3">
            <span className="font-gujarati text-[48px] leading-none text-sage-text">
              દાદી
            </span>
            <span className="text-[14px] font-medium tracking-[3px] text-ink-faint">
              DADI
            </span>
          </div>
          <p className="text-center text-[15px] leading-relaxed text-ink-muted">
            Scan a setup QR from Dadi, or paste the code. Needed once per
            install.
          </p>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Setup code"
            className="w-full border border-sage/40 bg-bone px-3 py-2 text-[14px] text-ink outline-none focus:border-sage"
            disabled={busy}
          />
          {error && (
            <p className="text-center text-[13px] text-ink-muted">{error}</p>
          )}
          <div className="flex items-center gap-6">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                setScanning(true);
              }}
              className="text-[12px] font-medium tracking-[2px] text-sage-deep disabled:opacity-50"
            >
              SCAN
            </button>
            <button
              type="submit"
              disabled={busy}
              className="text-[12px] font-medium tracking-[2px] text-sage-deep disabled:opacity-50"
            >
              {busy ? "JOINING…" : "JOIN"}
            </button>
          </div>
        </form>
      </div>
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
