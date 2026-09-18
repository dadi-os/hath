import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ghar } from "../../shared/api";
import type { GharDevice } from "../../shared/api/types";
import { useConnection } from "../../hooks/useConnection";
import { POLL_MS } from "../../shared/lib/ux/poll";

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

/**
 * Rooms and Matter devices. Preview matches the Nas crest: status lines,
 * room headers only when more than one room exists.
 */
export function GharRoster({ mode, className }: GharRosterProps) {
  const { state: connection } = useConnection();
  const connected = connection === "connected";
  const queryClient = useQueryClient();
  const preview = mode === "preview";

  const devicesQuery = useQuery({
    queryKey: ["ghar", "devices"],
    queryFn: () => ghar.listDevices(),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const toggle = useMutation({
    mutationFn: (id: string) => ghar.toggleSwitch(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ghar", "devices"] });
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
      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <section key={group.name} className="flex flex-col gap-1.5">
            {showRooms ? (
              <p className="text-[11px] font-medium tracking-[1.2px] text-ink-ghost">
                {group.name.toUpperCase()}
              </p>
            ) : null}
            {group.devices.map((device) => {
              const canSwitch = isSwitchable(device);
              const on = isOn(device);
              return (
                <button
                  key={device.id}
                  type="button"
                  disabled={!canSwitch || toggle.isPending}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!canSwitch) {
                      return;
                    }
                    toggle.mutate(device.id);
                  }}
                  className="flex h-11 w-full items-center gap-2.5 text-left disabled:cursor-default"
                >
                  <span
                    className={`size-[7px] shrink-0 rounded-full ${
                      device.online ? "bg-ink" : "bg-ink-ghost"
                    }`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                    {device.name}
                  </span>
                  {canSwitch ? (
                    <span className="shrink-0 text-[12px] text-ink-ghost">
                      {on ? "on" : "off"}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
