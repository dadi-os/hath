/**
 * House plan shared by the Ghar page and the home widget.
 * Named rooms are chambers under one roof. Unplaced devices sit on the stoop.
 * The widget draws each room as a window: the glass toggles that room's lights.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
  /** `preview` is the home widget: windows only. `full` is the page. */
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

/** Columns for `count` chambers, wide enough that a short last row can span instead of leaving a blank room. */
function chamberGrid(count: number): { cols: number } {
  if (count <= 1) {
    return { cols: 1 };
  }
  return { cols: Math.ceil(Math.sqrt(count)) };
}

/** How many columns the last chamber spans so the plan has no empty cell. */
function lastSpan(index: number, count: number, cols: number): number {
  const remainder = count % cols;
  if (remainder !== 0 && index === count - 1) {
    return cols - remainder + 1;
  }
  return 1;
}

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
 * The house. Preview windows toggle a room and do not navigate.
 * Full mode: press a lamp, drag it into another chamber. The ghost stays here.
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
    return <HouseNote>Ghar is offline</HouseNote>;
  }
  if (devicesQuery.isError && !devicesQuery.data) {
    return <HouseNote tone="error">{shownError(devicesQuery.error)}</HouseNote>;
  }
  if (roomsQuery.isError && !roomsQuery.data) {
    return <HouseNote tone="error">{shownError(roomsQuery.error)}</HouseNote>;
  }
  if (!devicesQuery.data || !roomsQuery.data) {
    if (!connected) {
      return <HouseNote>Ghar is offline</HouseNote>;
    }
    return <HouseNote>Loading…</HouseNote>;
  }

  const devices = devicesQuery.data.devices;
  const rooms = roomsQuery.data.rooms;
  const named = namedRooms(rooms, devices);
  const unassigned =
    rooms.find((room) => room.name === "unassigned") ??
    devices.find((device) => device.room.name === "unassigned")?.room ??
    null;
  const unplaced = devices.filter((device) => device.room.name === "unassigned");
  const { cols } = chamberGrid(named.length);
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

  return (
    <div ref={canvasRef} className="ghar">
      {!connected ? <p className="px-3 pt-1 text-[12px] text-ink-ghost">Ghar is offline</p> : null}
      {trouble ? <p className="px-3 pt-1 text-[12px] text-error">{trouble}</p> : null}
      <div
        className={`flex min-h-0 flex-1 flex-col ${mode === "full" ? "px-3 pb-3 pt-1" : "px-2 pb-2 pt-0.5"}`}
      >
        <div className={`ghar__canvas ${mode === "preview" ? "ghar__canvas--preview" : ""}`}>
          {mode === "full" ? (
            <div className="ghar-new">
              {naming ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitRoom();
                  }}
                >
                  <input
                    value={roomDraft}
                    autoFocus
                    placeholder="Room name"
                    onChange={(event) => setRoomDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setNaming(false);
                        setRoomDraft("");
                      }
                    }}
                    className="ghar-new__field"
                  />
                </form>
              ) : (
                <button
                  type="button"
                  aria-label="New room"
                  onClick={() => setNaming(true)}
                  className="inline-flex size-7 items-center justify-center text-sage-deep"
                >
                  <IconPlus />
                </button>
              )}
            </div>
          ) : null}
          <HouseRoof preview={mode === "preview"} />
          <LayoutGroup>
            {named.length === 0 ? (
              <div className="ghar-body ghar-body--empty">
                {devices.length === 0 ? (
                  <p className="text-[13px] text-ink-ghost">No devices</p>
                ) : mode === "preview" ? (
                  <p className="text-[13px] text-ink-ghost">Unplaced</p>
                ) : null}
              </div>
            ) : (
              <div
                className="ghar-body"
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
              >
                {named.map((room, index) => {
                  const span = lastSpan(index, named.length, cols);
                  const inRoom = devices.filter((device) => device.room.id === room.id);
                  const lit = inRoom.some(
                    (device) => device.online && isSwitchable(device) && isOn(device),
                  );
                  const hot = drag?.overId === room.id;
                  if (mode === "preview") {
                    return (
                      <Window
                        key={room.id}
                        room={room}
                        lit={lit}
                        span={span}
                        onToggle={() => toggleRoom(room.id)}
                      />
                    );
                  }
                  return (
                    <Chamber
                      key={room.id}
                      room={room}
                      lit={lit}
                      hot={hot}
                      span={span}
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
              </div>
            )}
            {mode === "full" && unassigned ? (
              <Stoop
                room={unassigned}
                devices={unplaced}
                hot={drag?.overId === unassigned.id}
                draggingId={drag?.id ?? null}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onRename={(id, name) => rename.mutate({ id, name })}
              />
            ) : mode === "preview" ? (
              <span className="ghar-stoop__door mx-auto" aria-hidden />
            ) : null}
          </LayoutGroup>
        </div>
      </div>
      {dragged && drag ? (
        <div
          className="ghar-ghost"
          style={{ left: drag.x, top: drag.y, transform: "translate(-50%, -70%)" }}
        >
          <DeviceNode device={dragged} />
        </div>
      ) : null}
    </div>
  );
}

/** Roof, eaves, and chimney. Stroke stays 1.5px while the drawing stretches. */
function HouseRoof({ preview }: { preview: boolean }) {
  return (
    <svg
      viewBox="0 0 400 64"
      preserveAspectRatio="none"
      aria-hidden
      className={`ghar-roof ${preview ? "ghar-roof--preview" : ""}`}
    >
      <path className="ghar-roof__face" d="M28 60 L200 10 L372 60 Z" />
      <path className="ghar-roof__edge" d="M8 60 L200 6 L392 60" />
      <rect className="ghar-roof__chimney" x="302" y="14" width="16" height="22" />
    </svg>
  );
}

/** Widget window. Click toggles the room and does not open the page. */
function Window({
  room,
  lit,
  span,
  onToggle,
}: {
  room: RoomRef;
  lit: boolean;
  span: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={lit}
      aria-label={`${roomTitle(room.name)} lights`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={`ghar-window ${lit ? "is-lit" : ""}`}
      style={span > 1 ? { gridColumn: `span ${span}` } : undefined}
    >
      <span className="ghar-window__glass">
        <span className="ghar-window__mullion ghar-window__mullion--v" />
        <span className="ghar-window__mullion ghar-window__mullion--h" />
        <span className="ghar-window__name">{roomTitle(room.name)}</span>
      </span>
    </button>
  );
}

type DeviceHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, device: GharDevice) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>, device: GharDevice) => void;
  onRename: (id: string, name: string) => void;
};

/** One room on the page: shared walls, lamps on the floor, a drop target. */
function Chamber({
  room,
  devices,
  lit,
  hot,
  span,
  draggingId,
  onFloor,
  ...handlers
}: DeviceHandlers & {
  room: RoomRef;
  devices: GharDevice[];
  lit: boolean;
  hot: boolean;
  span: number;
  draggingId: string | null;
  onFloor: () => void;
}) {
  return (
    <section
      data-room-id={room.id}
      aria-label={roomTitle(room.name)}
      className={`ghar-room ${lit ? "is-lit" : ""} ${hot ? "is-hot" : ""}`}
      style={span > 1 ? { gridColumn: `span ${span}` } : undefined}
      onClick={onFloor}
    >
      <span className="ghar-room__floor" aria-hidden />
      <p className="ghar-room__name">{roomTitle(room.name)}</p>
      <div className="ghar-room__field">
        {devices.map((device) => (
          <DeviceMark
            key={device.id}
            device={device}
            dimmed={draggingId === device.id}
            {...handlers}
          />
        ))}
      </div>
    </section>
  );
}

/** Porch outside the outline for devices that have no room yet. */
function Stoop({
  room,
  devices,
  hot,
  draggingId,
  ...handlers
}: DeviceHandlers & {
  room: RoomRef;
  devices: GharDevice[];
  hot: boolean;
  draggingId: string | null;
}) {
  return (
    <section
      data-room-id={room.id}
      aria-label="Unplaced"
      className={`ghar-stoop ${hot ? "is-hot" : ""}`}
    >
      <span className="ghar-stoop__door" aria-hidden />
      <p className="ghar-stoop__label">Unplaced</p>
      <div className="ghar-stoop__field">
        {devices.map((device) => (
          <DeviceMark
            key={device.id}
            device={device}
            dimmed={draggingId === device.id}
            {...handlers}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * A device on the plan. Press the disc to toggle; drag it between chambers.
 * Double-click the name to rename. `layoutId` carries it into the next room.
 */
function DeviceMark({
  device,
  dimmed,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onRename,
}: DeviceHandlers & { device: GharDevice; dimmed: boolean }) {
  const lit = device.online && isSwitchable(device) && isOn(device);
  const subtitle = productSubtitle(device);
  return (
    <motion.div
      layout
      layoutId={device.id}
      transition={{ layout: { duration: SLOW_S, ease: EASE } }}
      onPointerDown={(event) => onPointerDown(event, device)}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => onPointerUp(event, device)}
      onClick={(event) => event.stopPropagation()}
      className={`ghar-device ${lit ? "is-lit" : ""} ${device.online ? "" : "is-offline"} ${
        dimmed ? "is-ghosted" : ""
      }`}
    >
      <motion.span
        className="ghar-device__core"
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.94 }}
        transition={{ duration: 0.2, ease: EASE }}
        aria-pressed={isSwitchable(device) ? isOn(device) : undefined}
        role={isSwitchable(device) ? "button" : undefined}
        aria-label={device.name}
      >
        <span className="ghar-device__halo" aria-hidden />
        <span className="ghar-device__halo ghar-device__halo--delay" aria-hidden />
        <DeviceGlyph kind={glyphFor(device.capabilities)} lit={lit} />
      </motion.span>
      <DeviceName device={device} onRename={onRename} />
      {subtitle ? <span className="ghar-device__product">{subtitle}</span> : null}
    </motion.div>
  );
}

/** Ghost under the pointer. Positioned by the canvas, never the viewport. */
function DeviceNode({ device }: { device: GharDevice }) {
  const lit = device.online && isSwitchable(device) && isOn(device);
  return (
    <div className={`ghar-device ${lit ? "is-lit" : ""}`}>
      <span className="ghar-device__core">
        <DeviceGlyph kind={glyphFor(device.capabilities)} lit={lit} />
      </span>
    </div>
  );
}

/** In-place name. Double-click to edit so a press still toggles the lamp. */
function DeviceName({
  device,
  onRename,
}: {
  device: GharDevice;
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

  if (editing) {
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
        className="ghar-device__name ghar-device__name--edit"
      />
    );
  }

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
      className="ghar-device__name"
    >
      {device.name}
    </button>
  );
}

function HouseNote({
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
