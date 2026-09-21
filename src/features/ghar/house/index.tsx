/**
 * Ghar rooms — the same dashed glass panels as System, shared by the page
 * and the home widget. Widget tiles toggle a room and do not navigate.
 */

import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutGroup, motion } from "motion/react";
import { ghar, isMeshOnline } from "../../../shared/api";
import { GHAR_DEVICES_KEY, GHAR_ROOMS_KEY } from "../../../shared/api/ghar";
import type { GharDevice, GharRoom } from "../../../shared/api/types";
import { useConnection } from "../../../hooks/useConnection";
import { IconPlus } from "../../../shared/components/IconButton";
import { EASE, SLOW_S } from "../../../shared/lib/ux/motion";
import { POLL_MS } from "../../../shared/lib/ux/poll";
import { shownError, roomTitle } from "../commission";
import { DeviceGlyph, glyphFor } from "./icons";

export type GharHouseProps = {
  /** `preview` is the home widget: room tiles only. `full` is the page. */
  mode: "preview" | "full";
};

type RoomRef = { id: string; name: string };

type DragGhost = {
  id: string;
  x: number;
  y: number;
  overId: string | null;
};

type PointerSession = {
  id: string;
  startX: number;
  startY: number;
  dragging: boolean;
};

const DRAG_PX = 6;

const panel =
  "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius)] border border-dashed px-3 py-3 transition-[border-color,background-color,box-shadow] duration-slow ease-hath";

function isSwitchable(device: GharDevice): boolean {
  return device.capabilities.some((cap) => cap.capability === "switchable");
}

function isOn(device: GharDevice): boolean {
  return device.state.on?.value === true;
}

function productSubtitle(device: GharDevice): string | null {
  const product = device.product_name?.trim() ?? "";
  if (!product) {
    return null;
  }
  if (product.localeCompare(device.name.trim(), undefined, { sensitivity: "accent" }) === 0) {
    return null;
  }
  return product;
}

function panelTone(lit: boolean, hot: boolean): string {
  if (hot) {
    return "border-sage bg-sage-active/50";
  }
  if (lit) {
    return "border-sage bg-sage-faint/70";
  }
  return "border-sage-line bg-bone/40 hover:border-sage";
}

/** Flip `state.on` for each id so the lamp answers before Ghar does. */
function withToggled(devices: GharDevice[], ids: ReadonlySet<string>): GharDevice[] {
  return devices.map((device) => {
    if (!ids.has(device.id)) {
      return device;
    }
    const current = device.state.on;
    return {
      ...device,
      state: {
        ...device.state,
        on: {
          value: current?.value !== true,
          changed_at: current?.changed_at ?? new Date().toISOString(),
        },
      },
    };
  });
}

/**
 * Rooms and devices. Preview tiles toggle a room and do not navigate.
 * Full mode: press a device, drag it into another room. The ghost stays here.
 */
export function GharHouse({ mode }: GharHouseProps) {
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLDivElement>(null);
  const session = useRef<PointerSession | null>(null);
  const [drag, setDrag] = useState<DragGhost | null>(null);
  const [naming, setNaming] = useState(false);
  const [roomDraft, setRoomDraft] = useState("");

  const devicesQuery = useQuery({
    queryKey: GHAR_DEVICES_KEY,
    queryFn: () => ghar.listDevices(),
    enabled: connected,
    refetchInterval: connected ? POLL_MS : false,
  });
  const roomsQuery = useQuery({
    queryKey: GHAR_ROOMS_KEY,
    queryFn: () => ghar.listRooms(),
    enabled: connected,
  });

  const toggle = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => ghar.toggleSwitch(id))),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: GHAR_DEVICES_KEY });
      const previous = queryClient.getQueryData<{ devices: GharDevice[] }>(GHAR_DEVICES_KEY);
      const idSet = new Set(ids);
      queryClient.setQueryData<{ devices: GharDevice[] }>(GHAR_DEVICES_KEY, (current) =>
        current ? { devices: withToggled(current.devices, idSet) } : current,
      );
      return { previous };
    },
    onError: (_err, _ids, context) => {
      if (context?.previous) {
        queryClient.setQueryData(GHAR_DEVICES_KEY, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: GHAR_DEVICES_KEY });
    },
  });

  const move = useMutation({
    mutationFn: (input: { id: string; room: RoomRef }) => ghar.moveDevice(input.id, input.room.id),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: GHAR_DEVICES_KEY });
      const previous = queryClient.getQueryData<{ devices: GharDevice[] }>(GHAR_DEVICES_KEY);
      queryClient.setQueryData<{ devices: GharDevice[] }>(GHAR_DEVICES_KEY, (current) =>
        current
          ? {
              devices: current.devices.map((device) =>
                device.id === input.id ? { ...device, room: input.room } : device,
              ),
            }
          : current,
      );
      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(GHAR_DEVICES_KEY, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: GHAR_DEVICES_KEY });
    },
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) => ghar.renameDevice(input.id, input.name),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: GHAR_DEVICES_KEY });
      const previous = queryClient.getQueryData<{ devices: GharDevice[] }>(GHAR_DEVICES_KEY);
      queryClient.setQueryData<{ devices: GharDevice[] }>(GHAR_DEVICES_KEY, (current) =>
        current
          ? {
              devices: current.devices.map((device) =>
                device.id === input.id ? { ...device, name: input.name } : device,
              ),
            }
          : current,
      );
      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(GHAR_DEVICES_KEY, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: GHAR_DEVICES_KEY });
    },
  });

  const create = useMutation({
    mutationFn: (name: string) => ghar.createRoom(name),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: GHAR_ROOMS_KEY });
    },
  });

  if (!connected && !devicesQuery.data) {
    return <StatusNote>Ghar is offline</StatusNote>;
  }
  if (devicesQuery.isError && !devicesQuery.data) {
    return <StatusNote tone="error">{shownError(devicesQuery.error)}</StatusNote>;
  }
  if (mode === "full" && roomsQuery.isError && !roomsQuery.data) {
    return <StatusNote tone="error">{shownError(roomsQuery.error)}</StatusNote>;
  }
  if (!devicesQuery.data || (!roomsQuery.data && roomsQuery.isLoading)) {
    return <StatusNote>Loading…</StatusNote>;
  }

  const devices = devicesQuery.data.devices;
  const rooms = roomsQuery.data?.rooms ?? [];
  const named = namedRooms(rooms, devices);
  const unassigned =
    rooms.find((room) => room.name === "unassigned") ??
    devices.find((device) => device.room.name === "unassigned")?.room ??
    null;
  const panels: RoomRef[] =
    mode === "full" && unassigned ? [...named, unassigned] : named;
  const dragged = devices.find((device) => device.id === drag?.id) ?? null;

  const trouble =
    (toggle.isError ? shownError(toggle.error) : null) ??
    (move.isError ? shownError(move.error) : null) ??
    (rename.isError ? shownError(rename.error) : null) ??
    (create.isError ? shownError(create.error) : null) ??
    (roomsQuery.isError ? shownError(roomsQuery.error) : null);

  function toLocal(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) {
      return { x: clientX, y: clientY };
    }
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function roomAt(clientX: number, clientY: number): string | null {
    const hit = document
      .elementsFromPoint(clientX, clientY)
      .map((node) => (node instanceof Element ? node.closest("[data-room-id]") : null))
      .find((node): node is Element => node !== null);
    return hit?.getAttribute("data-room-id") ?? null;
  }

  function findRoom(id: string): RoomRef | null {
    const fromList = rooms.find((room) => room.id === id);
    if (fromList) {
      return { id: fromList.id, name: fromList.name };
    }
    const fromDevice = devices.find((device) => device.room.id === id)?.room;
    return fromDevice ? { id: fromDevice.id, name: fromDevice.name } : null;
  }

  function lightsIn(roomId: string): GharDevice[] {
    return devices.filter(
      (device) => device.room.id === roomId && device.online && isSwitchable(device),
    );
  }

  function toggleRoom(roomId: string): void {
    const lights = lightsIn(roomId);
    if (lights.length === 0 || !connected) {
      return;
    }
    const anyOn = lights.some(isOn);
    const ids = (anyOn ? lights.filter(isOn) : lights).map((device) => device.id);
    toggle.mutate(ids);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>, device: GharDevice): void {
    if (mode !== "full" || event.button !== 0 || !connected) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest("[data-rename]")) {
      return;
    }
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    session.current = {
      id: device.id,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const current = session.current;
    if (!current || !canvasRef.current) {
      return;
    }
    const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
    if (!current.dragging && distance < DRAG_PX) {
      return;
    }
    current.dragging = true;
    const local = toLocal(event.clientX, event.clientY);
    setDrag({
      id: current.id,
      x: local.x,
      y: local.y,
      overId: roomAt(event.clientX, event.clientY),
    });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>, device: GharDevice): void {
    const current = session.current;
    session.current = null;
    if (!current) {
      return;
    }
    event.stopPropagation();
    if (current.dragging) {
      const overId = roomAt(event.clientX, event.clientY);
      setDrag(null);
      if (overId && overId !== device.room.id) {
        const room = findRoom(overId);
        if (room) {
          move.mutate({ id: device.id, room });
        }
      }
      return;
    }
    if (connected && device.online && isSwitchable(device)) {
      toggle.mutate([device.id]);
    }
  }

  function submitRoom(): void {
    const name = roomDraft.trim();
    if (!name || create.isPending) {
      return;
    }
    setNaming(false);
    setRoomDraft("");
    create.mutate(name);
  }

  const emptyLabel =
    devices.length === 0 ? "No devices" : mode === "preview" ? "Unplaced" : null;

  return (
    <div ref={canvasRef} className="relative flex h-full min-h-0 flex-col">
      {!connected ? <p className="px-3 pt-1 text-[12px] text-ink-ghost">Ghar is offline</p> : null}
      {trouble ? <p className="px-3 pt-1 text-[12px] text-error">{trouble}</p> : null}
      <div
        className={`@container min-h-0 flex-1 ${mode === "full" ? "px-1 pb-1" : "px-2 pb-2.5 pt-0.5"}`}
      >
        {panels.length === 0 && !naming && mode === "preview" ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-[13px] text-ink-ghost">{emptyLabel}</p>
          </div>
        ) : (
          <LayoutGroup>
            <div
              className={
                mode === "preview"
                  ? "grid h-full min-h-0 grid-cols-2 gap-1.5"
                  : "grid h-full min-h-0 grid-cols-1 gap-4 @min-[560px]:grid-cols-2 @min-[900px]:grid-cols-3"
              }
            >
              {panels.map((room, index) => {
                const inRoom = devices.filter((device) => device.room.id === room.id);
                const lit = inRoom.some(
                  (device) => device.online && isSwitchable(device) && isOn(device),
                );
                const hot = drag?.overId === room.id;
                if (mode === "preview") {
                  return (
                    <PreviewTile
                      key={room.id}
                      room={room}
                      lit={lit}
                      delay={index * 0.03}
                      onToggle={() => toggleRoom(room.id)}
                    />
                  );
                }
                return (
                  <RoomPanel
                    key={room.id}
                    room={room}
                    lit={lit}
                    hot={hot}
                    delay={index * 0.03}
                    devices={inRoom}
                    draggingId={drag?.id ?? null}
                    onFloor={() => toggleRoom(room.id)}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onRename={(id, name) => rename.mutate({ id, name })}
                  />
                );
              })}
              {mode === "full" ? (
                <NewRoomPanel
                  naming={naming}
                  draft={roomDraft}
                  onDraft={setRoomDraft}
                  onStart={() => setNaming(true)}
                  onCancel={() => {
                    setNaming(false);
                    setRoomDraft("");
                  }}
                  onSubmit={submitRoom}
                />
              ) : null}
            </div>
          </LayoutGroup>
        )}
      </div>
      {dragged && drag ? (
        <div
          className="pointer-events-none absolute z-20"
          style={{ left: drag.x, top: drag.y, transform: "translate(-50%, -50%)" }}
        >
          <DeviceTile device={dragged} ghost />
        </div>
      ) : null}
    </div>
  );
}

/** Home widget tile. Click toggles the room and does not open the page. */
function PreviewTile({
  room,
  lit,
  delay,
  onToggle,
}: {
  room: RoomRef;
  lit: boolean;
  delay: number;
  onToggle: () => void;
}) {
  return (
    <motion.button
      type="button"
      aria-pressed={lit}
      aria-label={`${roomTitle(room.name)} lights`}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE, delay }}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.97 }}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={`${panel} justify-between ${panelTone(lit, false)}`}
    >
      <span
        className={`text-[10px] font-medium tracking-[1.2px] uppercase ${
          lit ? "text-sage-deep" : "text-ink-ghost"
        }`}
      >
        {roomTitle(room.name)}
      </span>
      <span
        className={`h-1.5 w-1.5 rounded-full ${lit ? "bg-sage" : "bg-ink-ghost"}`}
        aria-hidden
      />
    </motion.button>
  );
}

type DeviceHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, device: GharDevice) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>, device: GharDevice) => void;
  onRename: (id: string, name: string) => void;
};

/** One room — dashed glass, tracking label, devices you can press or drag. */
function RoomPanel({
  room,
  devices,
  lit,
  hot,
  delay,
  draggingId,
  onFloor,
  ...handlers
}: DeviceHandlers & {
  room: RoomRef;
  devices: GharDevice[];
  lit: boolean;
  hot: boolean;
  delay: number;
  draggingId: string | null;
  onFloor: () => void;
}) {
  return (
    <motion.section
      data-room-id={room.id}
      aria-label={roomTitle(room.name)}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE, delay }}
      className={`${panel} ${panelTone(lit, hot)}`}
      onClick={onFloor}
    >
      <span
        className={`mb-3 shrink-0 text-[11px] font-medium tracking-[2px] ${
          lit ? "text-sage-deep" : "text-ink-ghost"
        }`}
      >
        {roomTitle(room.name).toUpperCase()}
      </span>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {devices.map((device) => (
          <DeviceMark
            key={device.id}
            device={device}
            dimmed={draggingId === device.id}
            {...handlers}
          />
        ))}
      </div>
    </motion.section>
  );
}

/** Dashed empty panel — the same control language as a Timeline cell. */
function NewRoomPanel({
  naming,
  draft,
  onDraft,
  onStart,
  onCancel,
  onSubmit,
}: {
  naming: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onStart: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  if (naming) {
    return (
      <form
        className={`${panel} border-sage bg-bone/40`}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <span className="mb-3 text-[11px] font-medium tracking-[2px] text-sage-deep">
          NEW ROOM
        </span>
        <input
          value={draft}
          autoFocus
          placeholder="Name"
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onCancel();
            }
          }}
          className="border-b border-sage bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-ghost"
        />
      </form>
    );
  }

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.98 }}
      onClick={onStart}
      className={`group ${panel} items-start border-sage-line bg-bone/40 hover:border-sage`}
    >
      <span className="mb-3 text-[11px] font-medium tracking-[2px] text-ink-ghost">
        NEW ROOM
      </span>
      <span className="inline-flex size-7 items-center justify-center rounded-[6px] border border-dashed border-sage-line bg-[var(--glass-sheet)] text-sage-deep shadow-[var(--shadow)] transition-[border-color,background-color] duration-slow ease-hath group-hover:border-sage group-hover:bg-sage-active/50">
        <IconPlus />
      </span>
    </motion.button>
  );
}

/**
 * A device. Press to toggle; drag into another room; double-click the name to rename.
 * `layoutId` carries it across panels.
 */
function DeviceMark({
  device,
  dimmed,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onRename,
}: DeviceHandlers & { device: GharDevice; dimmed: boolean }) {
  return (
    <motion.div
      layout
      layoutId={device.id}
      transition={{ layout: { duration: SLOW_S, ease: EASE } }}
      onPointerDown={(event) => onPointerDown(event, device)}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => onPointerUp(event, device)}
      onClick={(event) => event.stopPropagation()}
      className={dimmed ? "opacity-30" : undefined}
    >
      <DeviceTile
        device={device}
        name={
          <DeviceName
            device={device}
            lit={device.online && isSwitchable(device) && isOn(device)}
            onRename={onRename}
          />
        }
      />
    </motion.div>
  );
}

/** Glass row for a device — hover and tap match the rest of the chrome. */
function DeviceTile({
  device,
  name,
  ghost,
}: {
  device: GharDevice;
  name?: ReactNode;
  ghost?: boolean;
}) {
  const lit = device.online && isSwitchable(device) && isOn(device);
  const subtitle = productSubtitle(device);
  return (
    <motion.div
      whileHover={ghost ? undefined : { y: -1 }}
      whileTap={ghost ? undefined : { scale: 0.98 }}
      transition={{ duration: 0.2, ease: EASE }}
      className={`flex items-center gap-2.5 rounded-[var(--radius)] border border-dashed px-2.5 py-2 shadow-[var(--shadow)] backdrop-blur-sm transition-[border-color,background-color] duration-slow ease-hath ${
        lit
          ? "border-sage bg-sage-active"
          : "border-sage-line bg-[var(--glass-sheet)] hover:border-sage hover:bg-sage-active/50"
      } ${device.online ? "" : "opacity-50"}`}
    >
      <span
        className={`flex size-7 shrink-0 items-center justify-center rounded-[6px] ${
          lit ? "text-sage-deep" : "text-ink-muted"
        }`}
      >
        <DeviceGlyph kind={glyphFor(device.capabilities)} lit={lit} />
      </span>
      <span className="min-w-0 flex-1">
        {name ?? (
          <span className={`block truncate text-[13px] ${lit ? "text-sage-deep" : "text-ink"}`}>
            {device.name}
          </span>
        )}
        {subtitle ? (
          <span className="block truncate text-[11px] text-ink-ghost">{subtitle}</span>
        ) : null}
      </span>
      {isSwitchable(device) ? (
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${lit ? "bg-sage" : "bg-ink-ghost"}`}
          aria-hidden
        />
      ) : null}
    </motion.div>
  );
}

/** In-place name. Double-click to edit so a press still toggles. */
function DeviceName({
  device,
  lit,
  onRename,
}: {
  device: GharDevice;
  /** Matches the lit tile so the label stays sage when the lamp is on. */
  lit: boolean;
  onRename: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.name);

  function commit(next: string): void {
    const trimmed = next.trim();
    setEditing(false);
    if (!trimmed || trimmed === device.name) {
      setDraft(device.name);
      return;
    }
    onRename(device.id, trimmed);
  }

  if (!editing) {
    return (
      <button
        type="button"
        data-rename=""
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setDraft(device.name);
          setEditing(true);
        }}
        className={`block max-w-full truncate text-left text-[13px] transition-colors duration-slow ease-hath ${
          lit ? "text-sage-deep" : "text-ink hover:text-sage-deep"
        }`}
      >
        {device.name}
      </button>
    );
  }

  return (
    <input
      data-rename=""
      value={draft}
      autoFocus
      aria-label={`Rename ${device.name}`}
      onPointerDown={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => commit(draft)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(device.name);
          setEditing(false);
        }
      }}
      className="mt-1 w-full border-b border-sage bg-transparent text-[13px] text-ink outline-none"
    />
  );
}

function StatusNote({
  children,
  tone = "quiet",
}: {
  children: string;
  tone?: "quiet" | "error";
}) {
  return (
    <div className="flex h-full items-center justify-center px-3">
      <p className={`text-center text-[13px] ${tone === "error" ? "text-error" : "text-ink-ghost"}`}>
        {children}
      </p>
    </div>
  );
}

/** Named rooms from the room list, plus any room a device already sits in. */
function namedRooms(rooms: GharRoom[], devices: GharDevice[]): RoomRef[] {
  const named: RoomRef[] = [];
  const seen = new Set<string>();
  for (const room of rooms) {
    if (room.name === "unassigned" || seen.has(room.id)) {
      continue;
    }
    seen.add(room.id);
    named.push({ id: room.id, name: room.name });
  }
  for (const device of devices) {
    if (device.room.name === "unassigned" || seen.has(device.room.id)) {
      continue;
    }
    seen.add(device.room.id);
    named.push({ id: device.room.id, name: device.room.name });
  }
  return named;
}
