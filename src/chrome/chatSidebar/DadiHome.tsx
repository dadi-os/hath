import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";

/** A Talk to Dadi send waiting on POST /dadi to pick a thread. */
export type DadiRouting = {
  /** Trimmed text that was sent. */
  text: string;
  /** Number of attachments sent with it. */
  attachments: number;
};

export type DadiHomeProps = {
  /** Reserve space above the floating composer. */
  composerPad: number;
  /** Set while Dadi decides where the message goes. */
  routing?: DadiRouting | null;
  /** Last send failed; the draft is back in the composer. */
  failed?: boolean;
};

/** Status copy while routing, with when each line takes over (ms). */
const ROUTING_PHASES: Array<{ at: number; label: string }> = [
  { at: 0, label: "Reading your message" },
  { at: 900, label: "Finding the right agent" },
  { at: 2800, label: "Opening the thread" },
];

/**
 * Empty Talk-to-Dadi surface. Motion is owned by the sidebar stage so this
 * mark doesn't animate a second time on the way in or out.
 *
 * While routing, the mark settles and breathes, the sent message sits under it,
 * and a thread line runs down to the status until the agent's chat opens.
 */
export function DadiHome({
  composerPad,
  routing = null,
  failed = false,
}: DadiHomeProps) {
  const reduced = useReducedMotion() ?? false;
  const busy = routing !== null;

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center px-8"
      style={{ paddingBottom: composerPad }}
    >
      <motion.span
        className="font-gujarati text-[52px] leading-none text-sage-text"
        animate={
          busy
            ? { scale: 0.74, opacity: reduced ? 1 : [0.55, 1, 0.55] }
            : { scale: 1, opacity: 1 }
        }
        transition={
          busy && !reduced
            ? {
                scale: { duration: SLOW_S, ease: EASE },
                opacity: { duration: 2.2, repeat: Infinity, ease: EASE },
              }
            : { duration: SLOW_S, ease: EASE }
        }
      >
        દાદી
      </motion.span>
      <AnimatePresence mode="wait" initial={false}>
        {routing ? (
          <RoutingTrail key="routing" routing={routing} reduced={reduced} />
        ) : (
          <motion.p
            key={failed ? "failed" : "idle"}
            role={failed ? "alert" : undefined}
            className={`mt-5 max-w-[15rem] text-center text-[13px] leading-relaxed tracking-[0.04em] ${
              failed ? "text-error" : "text-ink-muted"
            }`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: SLOW_S, ease: EASE }}
          >
            {failed
              ? "Dadi couldn't place that message. It's back in the composer."
              : "Talk to Dadi about anything"}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Sent message → drawing thread → routing status. */
function RoutingTrail({
  routing,
  reduced,
}: {
  routing: DadiRouting;
  reduced: boolean;
}) {
  const phase = useRoutingPhase();
  const label = ROUTING_PHASES[phase]!.label;
  const extra =
    routing.attachments > 0
      ? `${routing.attachments} attachment${routing.attachments === 1 ? "" : "s"}`
      : null;

  return (
    <motion.div
      className="mt-3 flex w-full max-w-[16rem] flex-col items-center"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      {routing.text ? (
        <div className="line-clamp-4 max-w-full rounded-[20px] bg-sage-active px-3.5 py-2.5 text-[14px] leading-[1.5] break-words whitespace-pre-wrap text-ink">
          {routing.text}
        </div>
      ) : null}
      {extra ? (
        <span className="mt-1.5 text-[11px] tracking-[0.04em] text-ink-ghost">
          {routing.text ? `+ ${extra}` : extra}
        </span>
      ) : null}
      <motion.div
        className="routing-thread mt-3 h-10 w-[1.5px] origin-top rounded-full"
        initial={{ scaleY: 0 }}
        animate={{ scaleY: 1 }}
        transition={{ duration: reduced ? 0 : 0.5, ease: EASE, delay: 0.12 }}
        aria-hidden
      />
      <div
        role="status"
        aria-live="polite"
        className="mt-3 flex h-4 items-center gap-2 text-[12px] tracking-[0.04em] text-sage-text"
      >
        <RoutingDots reduced={reduced} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={label}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/** Three sage beads pulsing in turn. */
function RoutingDots({ reduced }: { reduced: boolean }) {
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block size-[4px] rounded-full bg-sage"
          animate={reduced ? { opacity: 0.8 } : { opacity: [0.25, 1, 0.25] }}
          transition={
            reduced
              ? undefined
              : { duration: 1.1, repeat: Infinity, ease: EASE, delay: i * 0.16 }
          }
        />
      ))}
    </span>
  );
}

/** Index into ROUTING_PHASES, advancing on its schedule from mount. */
function useRoutingPhase(): number {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const timers = ROUTING_PHASES.slice(1).map((p, i) =>
      setTimeout(() => setPhase(i + 1), p.at),
    );
    return () => {
      for (const t of timers) {
        clearTimeout(t);
      }
    };
  }, []);
  return phase;
}
