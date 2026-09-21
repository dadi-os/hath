/**
 * Commission a Matter device into a room from the Ghar page.
 * Nearby pairing uses this computer as the Bluetooth radio.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ghar, isMeshOnline } from "../../shared/api";
import { GHAR_DEVICES_KEY, GHAR_ROOMS_KEY } from "../../shared/api/ghar";
import { isTauriRuntime } from "../../shared/api/runtime";
import type { GharCommissionJob, GharRoom } from "../../shared/api/types";
import { useConnection } from "../../hooks/useConnection";
import { startHathRadio } from "./radio";

export type CommissionSheetProps = {
  onClose: () => void;
};

type RadioMode = "network" | "nearby";

const EMPTY_ROOMS: GharRoom[] = [];

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
 * or this computer's Bluetooth. The plan stays visible beside it.
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
      className="flex h-full w-80 flex-col gap-4 overflow-y-auto border-l border-[var(--glass-border)] bg-[var(--glass-veil)] px-4 py-4 backdrop-blur-[var(--glass-blur)]"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-medium tracking-[0.16em] text-sage-deep uppercase">
                  Commission
                </p>
                <p className="mt-1 text-[12px] text-ink-ghost">
                  Pair a device and drop it into a room.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-[12px] text-ink-ghost"
              >
                Close
              </button>
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
                className="rounded-[14px] border border-sage-line/60 bg-bone/70 px-3 py-2.5 font-mono text-[15px] tracking-[0.12em] text-ink outline-none placeholder:text-ink-ghost/70 focus:border-sage"
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

            <div className="grid grid-cols-2 gap-1.5 rounded-[14px] border border-sage-line/50 bg-bone/50 p-1">
              <ModeButton
                active={radio === "network"}
                disabled={running}
                label="On the network"
                onSelect={() => setRadio("network")}
              />
              <ModeButton
                active={radio === "nearby"}
                disabled={running}
                label="This computer"
                onSelect={() => setRadio("nearby")}
              />
            </div>

            {radio === "nearby" ? (
              <div className="flex flex-col gap-2">
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
                  className="rounded-[14px] border border-sage-line/60 bg-bone/70 px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-ghost focus:border-sage"
                />
                <input
                  value={password}
                  disabled={running}
                  type="password"
                  placeholder="Wi-Fi password"
                  autoComplete="off"
                  onChange={(event) => setPassword(event.target.value)}
                  className="rounded-[14px] border border-sage-line/60 bg-bone/70 px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-ghost focus:border-sage"
                />
              </div>
            ) : (
              <p className="text-[12px] text-ink-muted">
                The device is already on the house network. Ghar finds it from the server.
              </p>
            )}

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

            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-[14px] bg-sage-deep px-3 py-2.5 text-[13px] font-medium text-bone disabled:opacity-40"
            >
              {running ? "Pairing…" : "Commission"}
            </button>
    </form>
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
      className={`shrink-0 rounded-full border px-3 py-1 text-[12px] ${
        selected
          ? "border-sage bg-sage-active text-sage-deep"
          : "border-sage-line/50 text-ink-muted"
      }`}
    >
      {roomTitle(room.name)}
    </button>
  );
}

type ModeButtonProps = {
  active: boolean;
  disabled: boolean;
  label: string;
  onSelect: () => void;
};

/** Network or this computer. */
function ModeButton({ active, disabled, label, onSelect }: ModeButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={`rounded-[11px] px-2 py-1.5 text-[12px] ${
        active ? "bg-sage-active text-sage-deep" : "text-ink-muted"
      }`}
    >
      {label}
    </button>
  );
}
