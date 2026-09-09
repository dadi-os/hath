import { useState } from "react";
import { motion } from "motion/react";
import { useConnection } from "../hooks/useConnection";
import { IconPower } from "../shared/components/IconButton";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";

/**
 * Frosted full-screen power control shown when provisioned but dadiMesh is down.
 * Tap joins the mesh; leave is handled from chrome while connected.
 */
export function MeshPowerOverlay() {
  const { state, connect } = useConnection();
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = localBusy || state === "connecting";

  const onPower = async () => {
    if (busy) {
      return;
    }
    setLocalBusy(true);
    setError(null);
    try {
      await connect();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <motion.div
      className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-bone/55 px-6 backdrop-blur-xl dark:bg-[#1a1c18]/70"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: SLOW_S, ease: EASE }}
      role="dialog"
      aria-label="Join dadiMesh"
    >
      <button
        type="button"
        onClick={() => {
          void onPower();
        }}
        disabled={busy}
        className="group relative flex h-28 w-28 items-center justify-center rounded-full border border-sage-line/80 bg-bone/40 shadow-[var(--shadow-deep)] backdrop-blur-md transition hover:border-sage hover:bg-sage-fill/30 disabled:opacity-70 dark:bg-[#2a2e28]/50"
        aria-label={busy ? "Connecting to dadiMesh" : "Join dadiMesh"}
      >
        {busy ? (
          <span
            className="h-10 w-10 animate-breath rounded-full border-2 border-sage/30 border-t-sage"
            aria-hidden
          />
        ) : (
          <span className="size-10 text-sage-deep transition group-hover:text-sage [&_svg]:size-full">
            <IconPower />
          </span>
        )}
      </button>
      <p className="mt-6 text-[12px] font-medium tracking-[2.5px] text-sage-deep">
        {busy ? "JOINING…" : "DADIMESH"}
      </p>
      <p className="mt-2 max-w-xs text-center text-[13px] text-ink-muted">
        {busy
          ? "Configuring the on-device tunnel…"
          : "Tap to join the mesh."}
      </p>
      {error ? (
        <p className="mt-3 max-w-sm text-center text-[13px] text-[#b56b5c]">
          {error}
        </p>
      ) : null}
    </motion.div>
  );
}
