/**
 * Ghar rooms — the same dashed glass panels as System, shared by the page
 * and the home widget. Widget tiles toggle a room and do not navigate.
 */

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ghar, isMeshOnline } from "../../../shared/api";
import { GHAR_DEVICES_KEY, GHAR_ROOMS_KEY } from "../../../shared/api/ghar";
import type { GharDevice, GharRoom } from "../../../shared/api/types";
import { useConnection } from "../../../hooks/useConnection";
import { IconPlus } from "../../../shared/components/IconButton";
import { Popover, type PopoverAnchor } from "../../../shared/components/Popover";
import { SearchField } from "../../../shared/components/SearchField";
import { POLL_MS } from "../../../shared/lib/ux/poll";
import { shownError, roomTitle, UnplacedCommission } from "../commission";
import { DeviceGlyph, glyphFor } from "./icons";
import { DevicePopover } from "./inspector";
import { searchHouse, type RoomRef } from "./search";

export type GharHouseProps = {
  /** `preview` is the home widget: room tiles only. `full` is the page. */
  mode: "preview" | "full";
  /** Page header slot for search and New room in `full` mode; null on the home widget. */
  toolbar: HTMLElement | null;
};

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

const DRAG_PX = 4;
/** How long a toggle stays gray even when Ghar answers immediately. */
const TOGGLE_HOLD_MS = 280;
const HOVER_OPEN_MS = 160;
const HOVER_CLOSE_MS = 320;
/**
 * New room form anchor past the button's bottom-right corner. Popover has no room
 * to open rightward at the header's edge, so it flips left and hangs right-aligned
 * just under the button instead of covering the search box.
 */
const NEW_ROOM_ANCHOR_OFFSET = { x: 28, y: 30 };

const panel =
  "flex min-h-0 min-w-0 flex-col rounded-[var(--radius)] border border-dashed px-3 py-3 transition-[border-color,background-color,box-shadow] duration-slow ease-hath";

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

/**
 * Write confirmed attributes after Ghar accepts a command.
 * The card stays on the previous reading until this runs.
 */
function confirmState(queryClient: QueryClient, id: string, values: Record<string, unknown>): void {
  const changedAt = new Date().toISOString();
  queryClient.setQueryData<{ devices: GharDevice[] }>(GHAR_DEVICES_KEY, (current) =>
    current
      ? {
          devices: current.devices.map((device) =>
            device.id === id
              ? {
                  ...device,
                  state: {
                    ...device.state,
                    ...Object.fromEntries(
                      Object.entries(values).map(([key, value]) => [key, { value, changed_at: changedAt }]),
                    ),
                  },
                }
              : device,
          ),
        }
      : current,
  );
}

/**
 * Rooms and devices. Preview tiles toggle a room and do not navigate.
 * Full mode: click a device to switch it, hover for its controls, drag it into a room.
 */
export function GharHouse({ mode, toolbar }: GharHouseProps) {
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLDivElement>(null);
  const session = useRef<PointerSession | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [drag, setDrag] = useState<DragGhost | null>(null);
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set());
  const waitingRef = useRef<Set<string>>(new Set());
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const [naming, setNaming] = useState(false);
  const [roomAnchor, setRoomAnchor] = useState<PopoverAnchor | null>(null);
  const [roomDraft, setRoomDraft] = useState("");
  const [query, setQuery] = useState("");
  const roomButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    return () => {
      if (openTimer.current !== null) {
        window.clearTimeout(openTimer.current);
      }
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
      }
    };
  }, []);

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
    onSuccess: (_data, ids) => {
      const current = queryClient.getQueryData<{ devices: GharDevice[] }>(GHAR_DEVICES_KEY);
      for (const id of ids) {
        const device = current?.devices.find((item) => item.id === id);
        confirmState(queryClient, id, { on: device?.state.on?.value !== true });
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: GHAR_DEVICES_KEY });
    },
  });

  const brightness = useMutation({
    mutationFn: (input: { id: string; level: number }) => ghar.setBrightness(input.id, input.level),
    onSuccess: (_data, input) => {
      confirmState(queryClient, input.id, { brightness: input.level });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: GHAR_DEVICES_KEY });
    },
  });

  const paint = useMutation({
    mutationFn: (
      input:
        | { id: string; hue: number; saturation: number }
        | { id: string; colorTemp: number },
    ) =>
      "colorTemp" in input
        ? ghar.setColorTemp(input.id, input.colorTemp)
        : ghar.setHue(input.id, input.hue, input.saturation),
    onSuccess: (_data, input) => {
      if ("colorTemp" in input) {
        confirmState(queryClient, input.id, { color_temp: input.colorTemp });
        return;
      }
      confirmState(queryClient, input.id, { hue: input.hue, saturation: input.saturation });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: GHAR_DEVICES_KEY });
    },
  });

  const identify = useMutation({
    mutationFn: (id: string) => ghar.identify(id),
  });

  const pendingIds = new Set<string>([
    ...waiting,
    ...(brightness.isPending && brightness.variables ? [brightness.variables.id] : []),
    ...(paint.isPending && paint.variables ? [paint.variables.id] : []),
    ...(identify.isPending && identify.variables ? [identify.variables] : []),
  ]);

  function beginToggle(ids: string[]): void {
    if (ids.length === 0 || ids.some((id) => waitingRef.current.has(id))) {
      return;
    }
    for (const id of ids) {
      waitingRef.current.add(id);
    }
    setWaiting(new Set(waitingRef.current));
    const started = Date.now();
    toggle.mutate(ids, {
      onSettled: () => {
        const hold = Math.max(0, TOGGLE_HOLD_MS - (Date.now() - started));
        window.setTimeout(() => {
          for (const id of ids) {
            waitingRef.current.delete(id);
          }
          setWaiting(new Set(waitingRef.current));
        }, hold);
      },
    });
  }

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
    mode === "full" && unassigned ? [unassigned, ...named] : named;
  const dragged = devices.find((device) => device.id === drag?.id) ?? null;
  const hovered = devices.find((device) => device.id === hoverId) ?? null;

  const search = searchHouse(query, panels, devices);

  const trouble =
    (toggle.isError ? shownError(toggle.error) : null) ??
    (brightness.isError ? shownError(brightness.error) : null) ??
    (paint.isError ? shownError(paint.error) : null) ??
    (identify.isError ? shownError(identify.error) : null) ??
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
    if (lights.some((device) => pendingIds.has(device.id))) {
      return;
    }
    const anyOn = lights.some(isOn);
    const ids = (anyOn ? lights.filter(isOn) : lights).map((device) => device.id);
    beginToggle(ids);
  }

  function clearOpenTimer(): void {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }

  function clearCloseTimer(): void {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function anchorFor(el: HTMLElement): PopoverAnchor {
    const canvas = canvasRef.current?.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    if (!canvas) {
      return { x: rect.right, y: rect.top + rect.height / 2 };
    }
    return {
      x: rect.right - canvas.left,
      y: rect.top - canvas.top + rect.height / 2,
    };
  }

  function scheduleHover(deviceId: string, el: HTMLElement): void {
    if (session.current?.dragging || drag) {
      return;
    }
    clearCloseTimer();
    if (hoverId === deviceId) {
      setAnchor(anchorFor(el));
      return;
    }
    clearOpenTimer();
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      if (session.current?.dragging) {
        return;
      }
      setHoverId(deviceId);
      setAnchor(anchorFor(el));
    }, HOVER_OPEN_MS);
  }

  function scheduleHoverClose(): void {
    clearOpenTimer();
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setHoverId(null);
      setAnchor(null);
    }, HOVER_CLOSE_MS);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>, device: GharDevice): void {
    if (mode !== "full" || event.button !== 0 || !connected) {
      return;
    }
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    clearOpenTimer();
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
    if (!current.dragging) {
      clearOpenTimer();
      clearCloseTimer();
      setHoverId(null);
      setAnchor(null);
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

  function endPointer(event: ReactPointerEvent<HTMLDivElement>, device: GharDevice): void {
    const current = session.current;
    session.current = null;
    if (!current || current.id !== device.id) {
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
    setDrag(null);
    if (connected && device.online && isSwitchable(device) && !pendingIds.has(device.id)) {
      beginToggle([device.id]);
    }
    scheduleHover(device.id, event.currentTarget);
  }

  function openNewRoom(): void {
    const button = roomButtonRef.current;
    const canvas = canvasRef.current;
    if (!button || !canvas) {
      return;
    }
    const rect = button.getBoundingClientRect();
    const origin = canvas.getBoundingClientRect();
    setRoomAnchor({
      x: rect.right - origin.left + NEW_ROOM_ANCHOR_OFFSET.x,
      y: rect.bottom - origin.top + NEW_ROOM_ANCHOR_OFFSET.y,
    });
    setNaming(true);
  }

  /** Open a device's controls as if hovered, e.g. when search narrows to it. */
  function showDevice(device: GharDevice): void {
    const el = canvasRef.current?.querySelector<HTMLElement>(`[data-device-id="${device.id}"]`);
    if (!el) {
      return;
    }
    clearOpenTimer();
    clearCloseTimer();
    setHoverId(device.id);
    setAnchor(anchorFor(el));
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
      {mode === "full" && toolbar
        ? createPortal(
            <>
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder="Search Ghar"
                matches={search.matches}
                onPick={() => {
                  if (search.lonelyDevice) {
                    showDevice(search.lonelyDevice);
                  }
                }}
              />
              <button
                ref={roomButtonRef}
                type="button"
                onClick={openNewRoom}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[7px] border border-dashed border-sage-line bg-[var(--glass-sheet)] px-3 text-[11px] font-medium tracking-[0.14em] whitespace-nowrap text-sage-deep uppercase shadow-[var(--shadow)] transition-[border-color,background-color] duration-slow ease-hath hover:border-sage hover:bg-sage-active/50"
              >
                <span className="flex size-4 shrink-0">
                  <IconPlus />
                </span>
                New room
              </button>
            </>,
            toolbar,
          )
        : null}
      <div
        className={`min-h-0 flex-1 [container-type:size] ${mode === "full" ? "px-3 pb-3" : "px-2 pb-2.5 pt-0.5"}`}
      >
        {panels.length === 0 && mode === "preview" ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-[13px] text-ink-ghost">{emptyLabel}</p>
          </div>
        ) : panels.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-[13px] text-ink-ghost">No rooms yet</p>
          </div>
        ) : search.rooms.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-[13px] text-ink-ghost">No rooms or devices match “{query.trim()}”</p>
          </div>
        ) : (
          <div
            className={
              mode === "preview"
                ? "grid h-full min-h-0 grid-cols-2 gap-1.5 @min-[420px]:grid-cols-3"
                : "grid h-full min-h-0 grid-cols-3 gap-3 overflow-y-auto [grid-auto-rows:calc((100cqh-0.75rem)/2)]"
            }
          >
            {search.rooms.map(({ room, listed }) => {
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
                    pending={inRoom.some((device) => pendingIds.has(device.id))}
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
                  devices={listed}
                  pendingIds={pendingIds}
                  draggingId={drag?.id ?? null}
                  onFloor={() => toggleRoom(room.id)}
                  onHover={scheduleHover}
                  onHoverEnd={scheduleHoverClose}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={endPointer}
                  onPointerCancel={endPointer}
                />
              );
            })}
          </div>
        )}
      </div>
      {mode === "full" && hovered && anchor ? (
        <DevicePopover
          device={hovered}
          open
          anchor={anchor}
          containerRef={canvasRef}
          pending={pendingIds.has(hovered.id)}
          onClose={() => {
            clearOpenTimer();
            clearCloseTimer();
            setHoverId(null);
            setAnchor(null);
          }}
          onHoverStart={clearCloseTimer}
          onHoverEnd={scheduleHoverClose}
          onRename={(name) => rename.mutate({ id: hovered.id, name })}
          onIdentify={() => {
            if (!pendingIds.has(hovered.id)) {
              identify.mutate(hovered.id);
            }
          }}
          onBrightness={(level) => {
            if (!pendingIds.has(hovered.id)) {
              brightness.mutate({ id: hovered.id, level });
            }
          }}
          onHue={(hue, saturation) => {
            if (!pendingIds.has(hovered.id)) {
              paint.mutate({ id: hovered.id, hue, saturation });
            }
          }}
          onColorTemp={(mireds) => {
            if (!pendingIds.has(hovered.id)) {
              paint.mutate({ id: hovered.id, colorTemp: mireds });
            }
          }}
        />
      ) : null}
      <Popover
        open={naming && roomAnchor !== null}
        onClose={() => {
          setNaming(false);
          setRoomDraft("");
        }}
        anchor={roomAnchor ?? { x: 0, y: 0 }}
        containerRef={canvasRef}
        aria-label="New room"
        widthPx={240}
      >
        <form
          className="flex flex-col gap-3 px-3.5 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            submitRoom();
          }}
        >
          <span className="text-[10px] font-medium tracking-[0.14em] text-sage-deep uppercase">
            New room
          </span>
          <input
            value={roomDraft}
            autoFocus
            placeholder="Name"
            aria-label="Room name"
            onChange={(event) => setRoomDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setNaming(false);
                setRoomDraft("");
              }
            }}
            className="border-b border-sage-line bg-transparent py-1 text-[14px] text-ink outline-none transition-colors duration-slow ease-hath placeholder:text-ink-ghost focus:border-sage"
          />
          <button
            type="submit"
            disabled={roomDraft.trim().length === 0 || create.isPending}
            className="self-start rounded-full bg-sage-deep px-3 py-1.5 text-[12px] font-medium text-bone transition-opacity duration-slow ease-hath hover:bg-sage disabled:cursor-default disabled:opacity-40"
          >
            {create.isPending ? "Adding…" : "Add room"}
          </button>
        </form>
      </Popover>
      {dragged && drag ? (
        <div
          className="pointer-events-none absolute z-20"
          style={{ left: drag.x, top: drag.y, transform: "translate(-50%, -50%)" }}
        >
          <DeviceTile device={dragged} ghost pending={false} />
        </div>
      ) : null}
    </div>
  );
}

/** Home widget tile. Click toggles the room and does not open the page. */
function PreviewTile({
  room,
  lit,
  pending,
  onToggle,
}: {
  room: RoomRef;
  lit: boolean;
  pending: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={lit}
      aria-busy={pending}
      aria-label={`${roomTitle(room.name)} lights`}
      disabled={pending}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={`${panel} justify-between ${
        pending ? "border-rule bg-rule/50" : panelTone(lit, false)
      }`}
    >
      <span
        className={`text-[10px] font-medium tracking-[1.2px] uppercase ${
          pending ? "text-ink-ghost" : lit ? "text-sage-deep" : "text-ink-ghost"
        }`}
      >
        {roomTitle(room.name)}
      </span>
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          pending ? "animate-breath bg-ink-ghost" : lit ? "bg-sage" : "bg-ink-ghost"
        }`}
        aria-hidden
      />
    </button>
  );
}

type DeviceHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, device: GharDevice) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>, device: GharDevice) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>, device: GharDevice) => void;
  onHover: (deviceId: string, el: HTMLElement) => void;
  onHoverEnd: () => void;
};

/** One room — dashed glass, tracking label, devices you can press or drag. */
function RoomPanel({
  room,
  devices,
  lit,
  hot,
  pendingIds,
  draggingId,
  onFloor,
  ...handlers
}: DeviceHandlers & {
  room: RoomRef;
  devices: GharDevice[];
  lit: boolean;
  hot: boolean;
  pendingIds: ReadonlySet<string>;
  draggingId: string | null;
  onFloor: () => void;
}) {
  return (
    <section
      data-room-id={room.id}
      aria-label={roomTitle(room.name)}
      onClick={onFloor}
      className={`${panel} min-h-0 cursor-pointer gap-3 px-3 py-3 ${panelTone(lit, hot)}`}
    >
      <span
        className={`shrink-0 self-start text-[11px] font-medium tracking-[2px] ${
          lit ? "text-sage-deep" : "text-ink-ghost"
        }`}
      >
        {roomTitle(room.name).toUpperCase()}
      </span>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {room.name === "unassigned" ? <UnplacedCommission /> : null}
        {devices.map((device) => (
          <DeviceMark
            key={device.id}
            device={device}
            pending={pendingIds.has(device.id)}
            dimmed={draggingId === device.id}
            {...handlers}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * A device row. Click switches it. Hover opens controls. A move drags it to another room.
 */
function DeviceMark({
  device,
  pending,
  dimmed,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onHover,
  onHoverEnd,
}: DeviceHandlers & {
  device: GharDevice;
  pending: boolean;
  dimmed: boolean;
}) {
  return (
    <div
      data-device-id={device.id}
      onPointerDown={(event) => onPointerDown(event, device)}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => onPointerUp(event, device)}
      onPointerCancel={(event) => onPointerCancel(event, device)}
      onMouseEnter={(event) => onHover(device.id, event.currentTarget)}
      onMouseLeave={onHoverEnd}
      onClick={(event) => event.stopPropagation()}
      className={`touch-none ${dimmed ? "opacity-30" : ""}`}
    >
      <DeviceTile device={device} pending={pending} />
    </div>
  );
}

/** Horizontal device row. The icon sits beside the name. */
function DeviceTile({
  device,
  pending,
  ghost,
}: {
  device: GharDevice;
  pending: boolean;
  ghost?: boolean;
}) {
  const lit = !pending && device.online && isSwitchable(device) && isOn(device);
  const subtitle = productSubtitle(device);
  const hue = device.state.hue?.value;
  const saturation = device.state.saturation?.value;
  const swatch =
    typeof hue === "number"
      ? `hsl(${Math.round((hue / 254) * 360)} ${Math.round(((typeof saturation === "number" ? saturation : 254) / 254) * 100)}% 52%)`
      : null;
  return (
    <div
      aria-busy={pending}
      className={`flex items-center gap-3 rounded-[var(--radius)] border border-dashed px-3 py-2.5 shadow-[var(--shadow)] backdrop-blur-sm ${
        pending ? "transition-none" : "transition-[border-color,background-color,opacity] duration-200 ease-hath"
      } ${ghost ? "w-64 cursor-grabbing" : "w-full cursor-grab"} ${
        pending
          ? "border-ink-ghost/50 bg-ink-ghost/20 text-ink-ghost"
          : lit
            ? "border-sage bg-sage-active hover:bg-sage-fill"
            : "border-sage-line bg-[var(--glass-sheet)] hover:border-sage hover:bg-sage-active/50"
      } ${device.online || pending ? "" : "opacity-50"}`}
    >
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-[8px] border border-dashed ${
          pending
            ? "border-rule text-ink-ghost"
            : lit
              ? "border-sage bg-sage-faint text-sage-deep"
              : "border-sage-line text-ink-muted"
        }`}
      >
        <DeviceGlyph kind={glyphFor(device.capabilities)} lit={lit} className="size-7 shrink-0" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <span
          className={`w-full truncate text-left text-[13px] leading-tight ${
            pending ? "text-ink-ghost" : lit ? "text-sage-deep" : "text-ink"
          }`}
        >
          {device.name}
        </span>
        {subtitle && !pending ? (
          <span className="w-full truncate text-left text-[11px] text-ink-ghost">{subtitle}</span>
        ) : null}
      </span>
      {isSwitchable(device) ? (
        <span className="inline-flex items-center gap-1" aria-hidden>
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              pending ? "animate-breath bg-ink-ghost" : lit ? "bg-sage" : "bg-ink-ghost"
            }`}
          />
          {swatch && !pending ? (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full border border-sage-line"
              style={{ background: swatch }}
            />
          ) : null}
        </span>
      ) : null}
    </div>
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
