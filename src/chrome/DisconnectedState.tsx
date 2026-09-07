import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  BundleDecodeError,
  decodeProvisioningBundle,
  loadCredentials,
  saveCredentials,
} from "../api/credentials";
import { transport } from "../api";

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

  useEffect(() => {
    let cancelled = false;
    void loadCredentials()
      .then((creds) => {
        if (!cancelled) {
          setProvisioned(creds !== null);
        }
      })
      .catch(() => {
        // Unreadable credentials → setup screen, not a blank/crash state.
        if (!cancelled) {
          setProvisioned(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const credentials = decodeProvisioningBundle(code);
      await transport.connect(credentials);
      await saveCredentials(credentials);
      setProvisioned(true);
      setCode("");
    } catch (err) {
      if (err instanceof BundleDecodeError) {
        setError(err.message);
      } else {
        // Surface Go / tsnet text (used or expired key, etc.)
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const showProvisioning =
    needsProvisioning || provisioned === false;

  if (provisioned === null && !needsProvisioning) {
    return null;
  }

  if (showProvisioning) {
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
            Paste a setup code from Dadi to join the mesh. Needed once per
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
          <button
            type="submit"
            disabled={busy}
            className="text-[12px] font-medium tracking-[2px] text-sage-deep disabled:opacity-50"
          >
            {busy ? "JOINING…" : "JOIN"}
          </button>
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
