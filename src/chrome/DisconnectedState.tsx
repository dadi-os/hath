import { useCallback, useState, type FormEvent } from "react";
import { motion } from "motion/react";
import {
  BundleDecodeError,
  decodeProvisioningBundle,
  saveCredentials,
  type Credentials,
} from "../shared/api/credentials";
import { transport } from "../shared/api";
import { useNeedsProvisioning } from "../hooks/useNeedsProvisioning";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";
import { QrScanner } from "./QrScanner";

/** Mesh join surface used during onboarding. */
type MeshJoinTransport = {
  connect(override?: Credentials): Promise<void>;
};

function asMeshJoin(t: unknown): MeshJoinTransport | null {
  if (
    t &&
    typeof t === "object" &&
    "connect" in t &&
    typeof (t as MeshJoinTransport).connect === "function"
  ) {
    return t as MeshJoinTransport;
  }
  return null;
}

/**
 * First-launch onboarding: scan or paste a provision code, then join dadiMesh.
 */
export function DisconnectedState() {
  const needsProvisioning = useNeedsProvisioning();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"camera" | "paste">("camera");

  const joinWithCode = useCallback(async (raw: string) => {
    const api = asMeshJoin(transport);
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

  if (!needsProvisioning) {
    return null;
  }

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
          JOIN DADIMESH
        </span>
        <p className="max-w-sm text-center text-[14px] leading-relaxed text-ink-muted">
          Scan or paste the setup code from Add Device on the box.
        </p>
      </div>

      <div className="glass-sheet flex min-h-0 w-full max-w-md flex-1 flex-col overflow-hidden rounded-[var(--radius-window)] p-4 shadow-[var(--shadow-deep)]">
        {busy ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <span
              className="h-8 w-8 animate-breath rounded-full border-2 border-sage/30 border-t-sage"
              aria-hidden
            />
            <p className="text-[12px] font-medium tracking-[2px] text-sage-deep">
              CONFIGURING DADIMESH…
            </p>
          </div>
        ) : mode === "camera" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <QrScanner
              fill
              onDecode={onScanDecode}
              onCancel={() => {
                setMode("paste");
                setError(null);
              }}
            />
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
                JOIN
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
