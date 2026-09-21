/**
 * Commission a Matter device into a room from the Ghar page.
 * Nearby pairing uses this computer as the Bluetooth radio.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ghar, isMeshOnline } from "../../shared/api";
import { GHAR_DEVICES_KEY, GHAR_ROOMS_KEY } from "../../shared/api/ghar";
import { isTauriRuntime } from "../../shared/api/runtime";
import type { GharCommissionJob, GharRoom } from "../../shared/api/types";
import { useConnection } from "../../hooks/useConnection";
import { IconButton, IconDismiss } from "../../shared/components/IconButton";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";
import { startHathRadio } from "./radio";

export type CommissionSheetProps = {
  onClose: () => void;
};

type RadioMode = "network" | "nearby";

const EMPTY_ROOMS: GharRoom[] = [];

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
function jobLine(job: GharCommissionJob, roomName: string): string {
  switch (job.status) {
    case "pending":
    case "discovering":
      return "Looking for the device";
    case "commissioning":
      return "Pairing";
    case "succeeded":
      return `Placed in ${roomTitle(roomName)}`;
    case "failed":
      return job.error ?? "Commissioning failed";
  }
}

/**
 * Side drawer: pairing code, destination room, and either the house network
 * or this computer's Bluetooth. The rooms stay visible beside it.
 */
export function CommissionSheet({ onClose }: CommissionSheetProps) {
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);
  const queryClient = useQueryClient();
  const roomsQuery = useQuery({
    queryKey: GHAR_ROOMS_KEY,
    queryFn: () => ghar.listRooms(),
    enabled: connected,
  });
  const rooms = roomsQuery.data?.rooms ?? EMPTY_ROOMS;
  const [code, setCode] = useState("");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [radio, setRadio] = useState<RadioMode>("network");
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [radioReady, setRadioReady] = useState(false);
  const [radioError, setRadioError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const selected = rooms.find((room) => room.id === roomId) ?? rooms[0];

  useEffect(() => {
    if (roomId === null && rooms[0]) {
      const named = rooms.find((room) => room.name !== "unassigned");
      setRoomId((named ?? rooms[0]).id);
    }
  }, [roomId, rooms]);

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
    if (jobQuery.data?.status === "succeeded") {
      void queryClient.invalidateQueries({ queryKey: GHAR_DEVICES_KEY });
    }
  }, [jobQuery.data?.status, queryClient]);

  const job = jobQuery.data ?? null;
  const running =
    pending ||
    (job !== null && job.status !== "succeeded" && job.status !== "failed");
  const nearbyBlocked =
    radio === "nearby" && (!radioReady || ssid.trim().length === 0);
  const canSubmit =
    connected &&
    code.trim().length > 0 &&
    selected !== undefined &&
    !running &&
    !nearbyBlocked;

  async function submit(): Promise<void> {
    if (!selected || !canSubmit) {
      return;
    }
    setSubmitError(null);
    setPending(true);
    try {
      const started = await ghar.startCommission({
        code: code.trim(),
        room_id: selected.id,
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

  const status = job
    ? jobLine(job, selected?.name ?? "")
    : submitError ?? (jobQuery.isError ? shownError(jobQuery.error) : null);

  return (
    <form
      className="flex h-full w-80 flex-col gap-5 overflow-y-auto border-l border-dashed border-sage-line bg-bone/40 px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium tracking-[2px] text-sage-deep">
            COMMISSION
          </p>
          <p className="mt-1 text-[12px] text-ink-ghost">
            Pair a device and drop it into a room.
          </p>
        </div>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <IconDismiss />
        </IconButton>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[10px] font-medium tracking-[0.14em] text-ink-ghost uppercase">
          Pairing code
        </span>
        <input
          value={code}
          disabled={running}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="3497-011-2332"
          onChange={(event) => setCode(event.target.value)}
          className={`${field} font-mono text-[15px] tracking-[0.12em]`}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-medium tracking-[0.14em] text-ink-ghost uppercase">
          Room
        </span>
        {roomsQuery.isError ? (
          <p className="text-[12px] text-error">{shownError(roomsQuery.error)}</p>
        ) : null}
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          {rooms.map((room) => (
            <RoomChip
              key={room.id}
              room={room}
              selected={selected?.id === room.id}
              disabled={running}
              onSelect={() => setRoomId(room.id)}
            />
          ))}
        </div>
      </div>

      <RadioGlider value={radio} disabled={running} onChange={setRadio} />

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
              disabled={running}
              placeholder="Wi-Fi name"
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(event) => setSsid(event.target.value)}
              className={`${field} text-[13px]`}
            />
            <input
              value={password}
              disabled={running}
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
            The device is already on the house network. Ghar finds it from the server.
          </motion.p>
        )}
      </AnimatePresence>

      {status ? (
        <p
          className={`text-[13px] ${
            job?.status === "failed" || submitError || jobQuery.isError
              ? "text-error"
              : "text-sage-deep"
          }`}
        >
          {status}
        </p>
      ) : null}

      <motion.button
        type="submit"
        disabled={!canSubmit}
        whileTap={canSubmit ? { scale: 0.98 } : undefined}
        transition={{ duration: 0.2, ease: EASE }}
        className="rounded-[var(--radius)] bg-sage-deep px-3 py-2.5 text-[13px] font-medium text-bone transition-[opacity,background-color] duration-slow ease-hath hover:bg-sage disabled:cursor-default disabled:opacity-40 disabled:hover:bg-sage-deep"
      >
        {running ? "Pairing…" : "Commission"}
      </motion.button>
    </form>
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

type RoomChipProps = {
  room: GharRoom;
  /** This chip is the destination. */
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
};

/** Destination room. */
function RoomChip({ room, selected, disabled, onSelect }: RoomChipProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={`shrink-0 rounded-full border border-dashed px-3 py-1 text-[12px] transition-colors duration-slow ease-hath ${
        selected
          ? "border-sage bg-sage-active text-sage-deep"
          : "border-rule text-ink-ghost hover:border-sage-line hover:text-ink-muted"
      } disabled:cursor-default`}
    >
      {roomTitle(room.name)}
    </button>
  );
}
