import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ghar, isMeshOnline } from "../../shared/api";
import type { GharDevice } from "../../shared/api/types";
import { useConnection } from "../../hooks/useConnection";
import { POLL_MS } from "../../shared/lib/ux/poll";

const DEVICES_KEY = ["ghar", "devices"] as const;

export type GharRosterProps = {
  mode: "preview" | "full";
  className?: string;
};

function isSwitchable(device: GharDevice): boolean {
  return device.capabilities.some((c) => c.capability === "switchable");
}

function isOn(device: GharDevice): boolean {
  return device.state.on?.value === true;
}

function roomGroups(devices: GharDevice[]): Array<{
  name: string;
  devices: GharDevice[];
}> {
  const byRoom = new Map<string, { name: string; devices: GharDevice[] }>();
  for (const device of devices) {
    const key = device.room.id;
    const group = byRoom.get(key);
    if (group) {
      group.devices.push(device);
    } else {
      byRoom.set(key, { name: device.room.name, devices: [device] });
    }
  }
  return [...byRoom.values()];
}

/** Flip `state.on` locally so a light card responds before Ghar answers. */
function withToggledSwitch(device: GharDevice): GharDevice {
  const current = device.state.on;
  const nextOn = current?.value !== true;
  return {
    ...device,
    state: {
      ...device.state,
      on: {
        value: nextOn,
        changed_at: current?.changed_at ?? new Date().toISOString(),
      },
    },
  };
}

/**
 * Device cards. Switchable lights toggle in place; other devices stay quiet.
 * Preview packs a short grid for the home widget. Full groups cards by room.
 */
export function GharRoster({ mode, className }: GharRosterProps) {
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);
  const queryClient = useQueryClient();
  const preview = mode === "preview";

  const devicesQuery = useQuery({
    queryKey: DEVICES_KEY,
    queryFn: () => ghar.listDevices(),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const toggle = useMutation({
    mutationFn: (id: string) => ghar.toggleSwitch(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: DEVICES_KEY });
      const previous = queryClient.getQueryData<{ devices: GharDevice[] }>(
        DEVICES_KEY,
      );
      queryClient.setQueryData<{ devices: GharDevice[] }>(DEVICES_KEY, (current) => {
        if (!current) {
          return current;
        }
        return {
          devices: current.devices.map((device) =>
            device.id === id ? withToggledSwitch(device) : device,
          ),
        };
      });
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(DEVICES_KEY, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
    },
  });

  if (!connected) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">No devices yet</p>
      </div>
    );
  }

  if (devicesQuery.isError) {
    return (
      <div className={`flex h-full items-center justify-center px-3 ${className ?? ""}`}>
        <p className="text-center text-[13px] text-ink-muted">
          {devicesQuery.error instanceof Error
            ? devicesQuery.error.message
            : String(devicesQuery.error)}
        </p>
      </div>
    );
  }

  if (devicesQuery.isLoading || !devicesQuery.data) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">Loading…</p>
      </div>
    );
  }

  const devices = devicesQuery.data.devices;
  if (devices.length === 0) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">No devices</p>
      </div>
    );
  }

  const groups = roomGroups(devices);
  const showRooms = groups.length > 1;

  return (
    <div
      className={`flex h-full min-h-0 flex-col overflow-y-auto ${
        preview ? "px-3 pb-2.5 pt-1" : ""
      } ${className ?? ""}`}
    >
      {toggle.isError ? (
        <p className="mb-2 px-3 text-[12px] text-error">
          {toggle.error instanceof Error
            ? toggle.error.message
            : String(toggle.error)}
        </p>
      ) : null}
      <div className={preview ? "grid grid-cols-2 gap-2" : "flex flex-col gap-4"}>
        {preview
          ? devices.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                roomLabel={showRooms ? device.room.name : null}
                pending={toggle.isPending && toggle.variables === device.id}
                onToggle={() => toggle.mutate(device.id)}
              />
            ))
          : groups.map((group) => (
              <section key={group.name} className="flex flex-col gap-2">
                {showRooms ? (
                  <p className="text-[11px] font-medium tracking-[0.14em] text-ink-ghost">
                    {group.name.toUpperCase()}
                  </p>
                ) : null}
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {group.devices.map((device) => (
                    <DeviceCard
                      key={device.id}
                      device={device}
                      roomLabel={null}
                      pending={toggle.isPending && toggle.variables === device.id}
                      onToggle={() => toggle.mutate(device.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
      </div>
    </div>
  );
}

/**
 * One device. A switchable light is the control; other devices are labels only.
 */
function DeviceCard({
  device,
  roomLabel,
  pending,
  onToggle,
}: {
  device: GharDevice;
  /** Room name when the preview grid is not already grouped. */
  roomLabel: string | null;
  pending: boolean;
  onToggle: () => void;
}) {
  const switchable = isSwitchable(device);
  const on = isOn(device);
  const lit = switchable && device.online && on;
  const status = !device.online
    ? "Offline"
    : switchable
      ? on
        ? "On"
        : "Off"
      : null;
  const face = `flex min-h-[4.25rem] flex-col justify-between rounded-[14px] border px-2.5 py-2 text-left transition-colors duration-slow ease-hath ${
    lit
      ? "border-sage/50 bg-sage-active"
      : "border-sage-line/50 bg-bone/45"
  } ${pending ? "opacity-70" : device.online ? "" : "opacity-50"}`;

  const body = (
    <>
      <span className="flex items-center justify-between gap-2">
        <span
          className={`size-1.5 shrink-0 rounded-full ${lit ? "bg-sage-deep" : "bg-ink-ghost"}`}
          aria-hidden
        />
        {status ? (
          <span
            className={`text-[10px] font-medium tracking-[0.14em] uppercase ${
              lit ? "text-sage-deep" : "text-ink-ghost"
            }`}
          >
            {status}
          </span>
        ) : null}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-ink">
          {device.name}
        </span>
        {roomLabel ? (
          <span className="mt-0.5 block truncate text-[11px] text-ink-ghost">
            {roomLabel}
          </span>
        ) : null}
      </span>
    </>
  );

  if (!switchable) {
    return <div className={face}>{body}</div>;
  }

  return (
    <button
      type="button"
      disabled={!device.online || pending}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        if (!device.online || pending) {
          return;
        }
        onToggle();
      }}
      className={`${face} cursor-pointer enabled:hover:border-sage disabled:cursor-default`}
    >
      {body}
    </button>
  );
}
