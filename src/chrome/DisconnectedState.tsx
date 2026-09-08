import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  BundleDecodeError,
  decodeProvisioningBundle,
  loadCredentials,
  saveCredentials,
} from "../shared/api/credentials";
import { transport } from "../shared/api";
import { QrScanner } from "./QrScanner";

function subscribeProvisioning(onStoreChange: () => void): () => void {
  return transport.onProvisioningNeeded(() => onStoreChange());
}

function getNeedsProvisioning(): boolean {
  return transport.needsProvisioningKey();
}

export function DisconnectedState() {
  const needsProvisioning = useSyncExternalStore(
    subscribeProvisioning,
    getNeedsProvisioning,
    getNeedsProvisioning,
  );
  const [provisioned, setProvisioned] = useState<boolean | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadCredentials()
      .then((creds) => {
        if (!cancelled) {
          setProvisioned(creds !== null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setProvisioned(false);
          setError(
            err instanceof Error ? err.message : "Could not read stored credentials",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const joinWithCode = useCallback(async (raw: string) => {
    setBusy(true);
    setError(null);
    try {
      const credentials = decodeProvisioningBundle(raw);
      await transport.connect(credentials);
      await saveCredentials(credentials);
      setProvisioned(true);
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

  const showProvisioning =
    needsProvisioning || provisioned === false;

  if (provisioned === null && !needsProvisioning) {
    return null;
  }

  if (showProvisioning) {
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
