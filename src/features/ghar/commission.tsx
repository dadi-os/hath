/**
 * Commission a Matter device from the plus slot in Unplaced.
 * The slot opens into a pairing code, then a connection phase.
 * Nearby pairing uses this computer as the Bluetooth radio.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ghar, isMeshOnline } from "../../shared/api";
import { GHAR_DEVICES_KEY } from "../../shared/api/ghar";
import { isTauriRuntime } from "../../shared/api/runtime";
import type { GharCommissionJob } from "../../shared/api/types";
import { useConnection } from "../../hooks/useConnection";
import { IconPlus } from "../../shared/components/IconButton";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";
import { startHathRadio } from "./radio";

type RadioMode = "network" | "nearby";
type PairPhase = "plus" | "code" | "link";

const field =
  "rounded-[var(--radius)] border border-dashed border-sage-line bg-[var(--glass-sheet)] px-3 py-2.5 text-ink outline-none transition-[border-color,background-color] duration-slow ease-hath placeholder:text-ink-ghost hover:border-sage focus:border-sage disabled:cursor-default disabled:opacity-50";

/** Human label for a room. The seeded room is the unplaced pile. */
export function roomTitle(name: string): string {
  return name === "unassigned" ? "Unplaced" : name;
}

/** First sentence of a transport or Ghar error, for the sheet. */
export function shownError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const match = err.message.match(/"message":"((?:\\.|[^"\\])*)"/);
  if (!match?.[1]) {
    return err.message;
  }
  return match[1].replace(/\\"/g, '"');
}

/** Status line while a job is in flight or finished. */
function jobLine(job: GharCommissionJob): string {
  switch (job.status) {
    case "pending":
    case "discovering":
      return "Looking for the device";
    case "commissioning":
      return "Pairing";
    case "succeeded":
      return "Landed in Unplaced";
    case "failed":
      return job.error ?? "Commissioning failed";
  }
}

/**
 * Plus slot in Unplaced. It opens into the pairing code, then the connection phase.
 * Clicks stay on the slot so they do not toggle the room.
 */
export function UnplacedCommission() {
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [radio, setRadio] = useState<RadioMode>("network");
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [radioReady, setRadioReady] = useState(false);
  const [radioError, setRadioError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState<PairPhase>("plus");

  useEffect(() => {
    if (radio !== "nearby") {
      setRadioReady(false);
      setRadioError(null);
      return;
    }
    if (!isTauriRuntime()) {
      setRadioReady(false);
      setRadioError("Bluetooth commissioning needs the Hath app on this computer.");
      return;
    }
    if (!connected) {
      setRadioReady(false);
      setRadioError("Ghar is offline.");
      return;
    }
    setRadioReady(false);
    setRadioError(null);
    const handle = startHathRadio(ghar, {
      onReady: () => {
        setRadioReady(true);
        setRadioError(null);
      },
      onError: (message) => {
        setRadioReady(false);
        setRadioError(message);
      },
    });
    return () => {
      handle.stop();
    };
  }, [radio, connected]);

  const jobQuery = useQuery({
    queryKey: ["ghar", "commission", jobId],
    queryFn: () => ghar.getCommission(jobId as string),
    enabled: connected && jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "succeeded" || status === "failed") {
        return false;
      }
      return 400;
    },
  });

  useEffect(() => {
    if (jobQuery.data?.status !== "succeeded") {
      return;
    }
    void queryClient.invalidateQueries({ queryKey: GHAR_DEVICES_KEY });
    const timer = window.setTimeout(() => {
      setPhase("plus");
      setCode("");
      setJobId(null);
      setRadio("network");
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [jobQuery.data?.status, queryClient]);

  const job = jobQuery.data ?? null;
  const running =
    pending ||
    (job !== null && job.status !== "succeeded" && job.status !== "failed");
  const nearbyBlocked =
    radio === "nearby" && (!radioReady || ssid.trim().length === 0);
  const canSubmit =
    connected && code.trim().length > 0 && !running && !nearbyBlocked;

  async function submit(): Promise<void> {
    if (!canSubmit) {
      return;
    }
    setSubmitError(null);
    setPending(true);
    setPhase("link");
    try {
      const started = await ghar.startCommission({
        code: code.trim(),
        radio,
        ...(radio === "nearby"
          ? { wifi: { ssid: ssid.trim(), password } }
          : {}),
      });
      setJobId(started.job_id);
    } catch (err) {
      setSubmitError(shownError(err));
    } finally {
      setPending(false);
    }
  }

  function close(): void {
    if (running) {
      return;
    }
    setPhase("plus");
    setRadio("network");
    setSubmitError(null);
    setJobId(null);
  }

  const status = job
    ? jobLine(job)
    : submitError ?? (jobQuery.isError ? shownError(jobQuery.error) : null);
  const failed = job?.status === "failed" || submitError !== null || jobQuery.isError;

  return (
    <motion.div
      layout
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      className="overflow-hidden rounded-[var(--radius)] border border-dashed border-sage-line bg-[var(--glass-sheet)]"
    >
      <AnimatePresence mode="wait" initial={false}>
        {phase === "plus" ? (
          <motion.button
            key="plus"
            type="button"
            aria-label="Commission a device"
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: SLOW_S, ease: EASE }}
            onClick={() => setPhase("code")}
            className="flex w-full items-center justify-center py-3.5 text-sage-deep transition-colors duration-slow ease-hath hover:bg-sage-active/50 [&_svg]:size-5"
          >
            <IconPlus />
          </motion.button>
        ) : null}
        {phase === "code" ? (
          <motion.form
            key="code"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: SLOW_S, ease: EASE }}
            className="flex flex-col gap-3 px-3 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium tracking-[0.14em] text-sage-deep uppercase">
                Setup code
              </span>
              <button
                type="button"
                onClick={close}
                className="text-[11px] tracking-wide text-ink-ghost hover:text-ink-muted"
              >
                ESC
              </button>
            </div>
            <input
              value={code}
              autoFocus
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="3497-011-2332"
              onChange={(event) => setCode(event.target.value)}
              className={`${field} font-mono text-[15px] tracking-[0.12em]`}
            />
            <RadioGlider value={radio} disabled={false} onChange={setRadio} />
            <AnimatePresence mode="wait" initial={false}>
              {radio === "nearby" ? (
                <motion.div
                  key="nearby"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: SLOW_S, ease: EASE }}
                  className="flex flex-col gap-2"
                >
                  <p className="text-[12px] text-ink-muted">
                    {radioError ??
                      (radioReady
                        ? "Hold this computer next to the device. The password is sent once and not saved."
                        : "Opening this computer's radio…")}
                  </p>
                  <input
                    value={ssid}
                    placeholder="Wi-Fi name"
                    autoCapitalize="none"
                    autoCorrect="off"
                    onChange={(event) => setSsid(event.target.value)}
                    className={`${field} text-[13px]`}
                  />
                  <input
                    value={password}
                    type="password"
                    placeholder="Wi-Fi password"
                    autoComplete="off"
                    onChange={(event) => setPassword(event.target.value)}
                    className={`${field} text-[13px]`}
                  />
                </motion.div>
              ) : (
                <motion.p
                  key="network"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: SLOW_S, ease: EASE }}
                  className="text-[12px] text-ink-muted"
                >
                  The device is already on the house network.
                </motion.p>
              )}
            </AnimatePresence>
            <button
              type="submit"
              disabled={!canSubmit}
              className="self-start rounded-full bg-sage-deep px-3 py-1.5 text-[12px] font-medium text-bone transition-opacity duration-slow ease-hath hover:bg-sage disabled:cursor-default disabled:opacity-40"
            >
              Pair
            </button>
          </motion.form>
        ) : null}
        {phase === "link" ? (
          <motion.div
            key="link"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: SLOW_S, ease: EASE }}
            className="flex flex-col gap-3 px-3 py-3"
          >
            <span className="text-[10px] font-medium tracking-[0.14em] text-sage-deep uppercase">
              Connecting
            </span>
            <ConnectionPhase
              status={job?.status ?? (pending ? "pending" : null)}
              failed={failed}
              detail={status}
            />
            {failed ? (
              <button
                type="button"
                onClick={() => {
                  setJobId(null);
                  setSubmitError(null);
                  setPhase("code");
                }}
                className="self-start text-[12px] text-ink-ghost hover:text-ink-muted"
              >
                Try again
              </button>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

/** The three beats of a pairing job, with the active one breathing. */
function ConnectionPhase({
  status,
  failed,
  detail,
}: {
  status: GharCommissionJob["status"] | null;
  failed: boolean;
  detail: string | null;
}) {
  const step =
    failed ? 2 : status === "commissioning" ? 1 : status === "succeeded" ? 2 : 0;
  const steps = ["Looking", "Pairing", "In Unplaced"] as const;
  return (
    <ol className="flex flex-col gap-1.5">
      {steps.map((label, index) => {
        const active = index === step;
        const done = index < step && !failed;
        return (
          <li
            key={label}
            className={`flex items-center gap-2 text-[13px] ${
              failed && active
                ? "text-error"
                : active || done
                  ? "text-sage-deep"
                  : "text-ink-ghost"
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${
                failed && active
                  ? "bg-error"
                  : active
                    ? "animate-breath bg-sage"
                    : done
                      ? "bg-sage"
                      : "bg-ink-ghost"
              }`}
              aria-hidden
            />
            {label}
          </li>
        );
      })}
      {detail ? (
        <li className={`pl-3.5 text-[12px] ${failed ? "text-error" : "text-ink-muted"}`}>
          {detail}
        </li>
      ) : null}
    </ol>
  );
}

/** Sliding track — same glider as log severity. */
function RadioGlider({
  value,
  disabled,
  onChange,
}: {
  value: RadioMode;
  disabled: boolean;
  onChange: (value: RadioMode) => void;
}) {
  const index = value === "network" ? 0 : 1;
  return (
    <div
      role="radiogroup"
      aria-label="Radio"
      className="relative grid grid-cols-2 rounded-full bg-sage-fill p-0.5"
    >
      <motion.div
        className="absolute inset-y-0.5 rounded-full bg-bone shadow-[var(--shadow)] ring-1 ring-sage-line/80"
        initial={false}
        animate={{
          left: `calc(${index} * 50% + 2px)`,
          width: "calc(50% - 4px)",
        }}
        transition={{ duration: SLOW_S, ease: EASE }}
      />
      {(
        [
          ["network", "On the network"],
          ["nearby", "This computer"],
        ] as const
      ).map(([mode, label]) => {
        const on = value === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(mode)}
            className={`relative z-10 px-2.5 py-1.5 text-[12px] tracking-wide transition-colors duration-slow ease-hath ${
              on ? "text-sage-deep" : "text-ink-ghost hover:text-ink-muted"
            } disabled:cursor-default`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

