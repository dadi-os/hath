import { useState, useSyncExternalStore, type FormEvent } from "react";
import {
  AuthKeyRequiredError,
  saveAuthKey,
  TsnetTransport,
} from "../api/tsnet-transport";
import { transport } from "../api";
import { connectTransport } from "../store/connection";

function subscribeAuthNeeded(onStoreChange: () => void): () => void {
  if (!(transport instanceof TsnetTransport)) {
    return () => {};
  }
  return transport.onAuthKeyNeeded(() => onStoreChange());
}

function getAuthNeeded(): boolean {
  return transport instanceof TsnetTransport && transport.authKeyNeeded();
}

export function DisconnectedState() {
  const needsAuth = useSyncExternalStore(
    subscribeAuthNeeded,
    getAuthNeeded,
    getAuthNeeded,
  );
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      setError("Paste a Headscale pre-auth key");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveAuthKey(trimmed);
      await connectTransport();
      setKey("");
    } catch (err) {
      if (err instanceof AuthKeyRequiredError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  if (needsAuth) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <form
          onSubmit={(e) => {
            void onSubmit(e);
          }}
          className="flex w-full max-w-sm flex-col gap-4"
        >
          <p className="text-center text-[15px] leading-relaxed text-ink-muted">
            Paste a Headscale pre-auth key to join the mesh. Needed once per
            install.
          </p>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="hskey-…"
            className="w-full border border-sage/40 bg-bone px-3 py-2 text-[14px] text-ink outline-none focus:border-sage"
            disabled={busy}
          />
          {error && (
            <p className="text-center text-[13px] text-ink-muted">{error}</p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="self-center text-[12px] font-medium tracking-[2px] text-sage-deep disabled:opacity-50"
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
        Waiting for the mesh. Tap the power icon when you are ready to connect.
      </p>
    </div>
  );
}
