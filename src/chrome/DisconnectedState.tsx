import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
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

/** Narrow the shared transport to the mesh join API, or null when unavailable. */
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
 * First-launch overlay: scan or paste a provision code, then join dadiMesh.
 * Frosts the chrome underneath until credentials are saved.
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
    setError(null);
    let credentials: Credentials;
    try {
      credentials = decodeProvisioningBundle(raw);
    } catch (err) {
      setCode(raw);
      setMode("paste");
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(true);
    try {
      await api.connect(credentials);
      await saveCredentials(credentials);
      setCode("");
    } catch (err) {
      setCode(raw);
      setMode("paste");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (busy) {
        return;
      }
      const text = e.clipboardData?.getData("text")?.trim();
      if (!text) {
        return;
      }
      e.preventDefault();
      setCode(text);
      setMode("paste");
      void joinWithCode(text);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [busy, joinWithCode]);

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

  const panelKey = busy ? "busy" : mode;

  return (
    <motion.div
      className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-bone/55 px-6 backdrop-blur-xl dark:bg-[#1a1c18]/70"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: SLOW_S, ease: EASE }}
      role="dialog"
      aria-modal="true"
      aria-label="Join dadiMesh"
    >
      <motion.div
        className="flex h-[min(36rem,calc(100dvh-4rem))] w-full max-w-md flex-col items-center"
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
            Scan or paste the setup code from Add Device on the box. Joining
            installs a system mesh (TUN + MagicDNS) so Terminal, SSH, and other
            apps can reach *.dadi — macOS may ask for admin; Windows for UAC /
            Wintun.
          </p>
        </div>

        <div className="glass-sheet flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[var(--radius-window)] p-4 shadow-[var(--shadow-deep)]">
          <AnimatePresence mode="wait" initial={false}>
            {busy ? (
              <motion.div
                key="busy"
                className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: SLOW_S, ease: EASE }}
              >
                <span
                  className="h-8 w-8 animate-spin rounded-full border-2 border-sage/30 border-t-sage"
                  aria-hidden
                />
                <p className="text-[12px] font-medium tracking-[2px] text-sage-deep">
                  CONFIGURING DADIMESH…
                </p>
              </motion.div>
            ) : panelKey === "camera" ? (
              <motion.div
                key="camera"
                className="flex min-h-0 flex-1 flex-col"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: SLOW_S, ease: EASE }}
              >
                <QrScanner
                  fill
                  onDecode={onScanDecode}
                  onCancel={() => {
                    setMode("paste");
                    setError(null);
                  }}
                />
                {error ? (
                  <p className="mt-3 text-center text-[13px] text-[#b56b5c]">
                    {error}
                  </p>
                ) : null}
              </motion.div>
            ) : (
              <motion.form
                key="paste"
                onSubmit={(e) => {
                  void onSubmit(e);
                }}
                className="flex min-h-0 flex-1 flex-col gap-4"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: SLOW_S, ease: EASE }}
              >
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium tracking-[2px] text-sage-deep">
                    SETUP CODE
                  </span>
                  <textarea
                    autoFocus
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
                  <p className="text-center text-[13px] text-[#b56b5c]">
                    {error}
                  </p>
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
              </motion.form>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}
