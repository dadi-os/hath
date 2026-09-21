import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { isMeshOnline, nas } from "../../shared/api";
import type { NasStatus } from "../../shared/api/nas";
import { ErrorLogCards } from "../logs/LogExplorer";
import { useConnection } from "../../hooks/useConnection";
import { useElementSize } from "./useElementSize";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";
import { POLL_MS } from "../../shared/lib/ux/poll";

export type SystemMapProps = {
  mode: "full" | "preview";
  className?: string;
};

const SERVICE_ORDER = [
  "dwar",
  "yaad",
  "dimaag",
  "ghar",
  "chaavi",
  "nas",
  "hath",
] as const;

/** Density breakpoints for the System widget body. */
type SystemDensity = "pending" | "full" | "cards" | "inline";

function densityFor(size: { width: number; height: number }): SystemDensity {
  if (size.width === 0 || size.height === 0) {
    return "pending";
  }
  if (size.height < 220 || size.width < 160) {
    return "inline";
  }
  if (size.height < 320 || size.width < 220) {
    return "cards";
  }
  return "full";
}

function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function diskVolumePct(free: number, total: number, usedPercent?: number): number {
  if (typeof usedPercent === "number" && Number.isFinite(usedPercent)) {
    return Math.min(100, Math.max(0, usedPercent));
  }
  if (total <= 0) {
    return 0;
  }
  return Math.min(100, (1 - free / total) * 100);
}

function diskDisplayName(d: {
  name: string;
  model?: string;
  transport?: string;
  mount: string;
}): string {
  if (d.model && d.model.trim()) {
    return d.model.trim();
  }
  if (d.transport) {
    return `${d.name} (${d.transport})`;
  }
  return d.name;
}

function serviceHealth(status: NasStatus): Array<{ name: string; ok: boolean }> {
  const byName = new Map(status.services.map((s) => [s.name, s.healthy]));
  byName.set("nas", true);
  const seen = new Set<string>();
  const rows: Array<{ name: string; ok: boolean }> = [];
  for (const name of SERVICE_ORDER) {
    if (name === "nas" || byName.has(name)) {
      rows.push({ name, ok: byName.get(name) ?? false });
      seen.add(name);
    }
  }
  for (const s of status.services) {
    if (!seen.has(s.name)) {
      rows.push({ name: s.name, ok: s.healthy });
    }
  }
  return rows;
}

type ResourceRow = {
  key: string;
  kind: string;
  name: string;
  pct: number | null;
  detail?: string;
};

function resourceRows(status: NasStatus): ResourceRow[] {
  const rows: ResourceRow[] = [];
  if (status.cpu) {
    rows.push({
      key: "cpu",
      kind: "CPU",
      name: status.cpu.name,
      pct: status.cpu.used_percent,
    });
  }
  if (status.memory && status.memory.total_bytes > 0) {
    rows.push({
      key: "memory",
      kind: "RAM",
      name: status.memory.name || "System memory",
      pct: status.memory.used_percent,
      detail: `${formatBytes(status.memory.used_bytes)} / ${formatBytes(status.memory.total_bytes)}`,
    });
  }
  for (const [i, gpu] of (status.gpu ?? []).entries()) {
    rows.push({
      key: `gpu-${i}`,
      kind: "GPU",
      name: gpu.name,
      pct: gpu.used_percent ?? null,
    });
  }
  const volumes = status.disks?.length
    ? status.disks
    : status.disk.total_bytes > 0
      ? [
          {
            name: "state",
            mount: "/",
            free_bytes: status.disk.free_bytes,
            total_bytes: status.disk.total_bytes,
            used_percent: status.disk.used_percent ?? diskVolumePct(status.disk.free_bytes, status.disk.total_bytes),
          },
        ]
      : [];
  for (const d of volumes) {
    if (d.total_bytes <= 0) {
      continue;
    }
    rows.push({
      key: `disk-${d.name}`,
      kind: volumes.length > 1 ? shortDiskKind(d) : "DISK",
      name: diskDisplayName(d),
      pct: diskVolumePct(d.free_bytes, d.total_bytes, d.used_percent),
      detail: `${formatBytes(d.free_bytes)} free of ${formatBytes(d.total_bytes)} · ${d.mount}`,
    });
  }
  return rows;
}

function shortDiskKind(d: {
  name: string;
  transport?: string;
  mount: string;
}): string {
  if (d.mount === "/var/home" || d.mount === "/home") {
    return "HOME";
  }
  if (d.mount === "/var" || d.mount === "/" || d.mount === "/sysroot") {
    return "OS";
  }
  const t = (d.transport || "").toLowerCase();
  if (t === "nvme" || d.name.startsWith("nvme")) {
    return "NVME";
  }
  return d.name.slice(0, 8).toUpperCase();
}

/**
 * Dadi health. Preview is modules, mesh clients, and host meters.
 * Full mode is the left health column plus logs.
 */
export function SystemMap({ mode, className }: SystemMapProps) {
  const { state: connection } = useConnection();
  const connected = isMeshOnline(connection);
  const preview = mode === "preview";

  const statusQuery = useQuery({
    queryKey: ["nas", "status"],
    queryFn: () => nas.getStatus(),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const clientsQuery = useQuery({
    queryKey: ["nas", "clients"],
    queryFn: () => nas.listClients(),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  if (!connected) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">No status yet</p>
      </div>
    );
  }

  if (statusQuery.isError) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-muted">Could not load status.</p>
      </div>
    );
  }

  if (statusQuery.isLoading || !statusQuery.data) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">Loading…</p>
      </div>
    );
  }

  const status = statusQuery.data;
  const services = serviceHealth(status);
  const resources = resourceRows(status);

  if (preview) {
    if (clientsQuery.isError) {
      return (
        <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
          <p className="text-[13px] text-ink-muted">
            {clientsQuery.error instanceof Error
              ? clientsQuery.error.message
              : String(clientsQuery.error)}
          </p>
        </div>
      );
    }
    if (clientsQuery.isLoading || !clientsQuery.data) {
      return (
        <SystemPreview
          className={className}
          services={services}
          resources={resources}
          clients={[]}
          clientsPending
        />
      );
    }
    return (
      <SystemPreview
        className={className}
        services={services}
        resources={resources}
        clients={clientsQuery.data.clients}
      />
    );
  }

  return (
    <div className={`flex h-full min-h-0 flex-col gap-4 ${className ?? ""}`}>
      <ServiceRows services={services} />
      <ResourceMeters rows={resources} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ErrorLogCards limit={6} />
      </div>
    </div>
  );
}

function clientLabel(c: {
  pending: boolean;
  online: boolean;
}): string {
  if (c.pending) {
    return "waiting";
  }
  return c.online ? "online" : "offline";
}

function SystemPreview({
  className,
  services,
  resources,
  clients,
  clientsPending = false,
}: {
  className?: string;
  services: Array<{ name: string; ok: boolean }>;
  resources: ResourceRow[];
  clients: Array<{
    node_name: string;
    online: boolean;
    pending: boolean;
  }>;
  clientsPending?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(rootRef);
  const density = densityFor(size);
  const meters = resources
    .filter(
      (r) =>
        r.key === "cpu" || r.key === "memory" || r.key.startsWith("disk"),
    )
    .slice(0, 4);
  const mesh = clients.filter((c) => c.node_name && c.node_name !== "os");
  const okCount = services.filter((s) => s.ok).length;

  if (density === "pending") {
    return (
      <div
        ref={rootRef}
        className={`h-full min-h-0 w-full ${className ?? ""}`}
        aria-hidden
      />
    );
  }

  if (density === "inline") {
    return (
      <div
        ref={rootRef}
        className={`flex h-full min-h-0 flex-col justify-between gap-2 overflow-hidden px-3 pb-2.5 pt-1 ${className ?? ""}`}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[11px] font-medium tracking-[1.2px] text-ink-ghost">
            MODULES
          </span>
          <span className="text-[12px] tabular-nums text-ink">
            {okCount}/{services.length}
          </span>
          <span className="text-ink-ghost">·</span>
          {services.map((s) => (
            <span
              key={s.name}
              className={`font-mono text-[11px] ${
                s.ok ? "text-sage-deep" : "text-error"
              }`}
              title={s.ok ? "reachable" : "unreachable"}
            >
              {s.name}
            </span>
          ))}
        </div>
        <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
          {meters.map((row) => (
            <span
              key={row.key}
              className="inline-flex items-baseline gap-1 text-[12px] tabular-nums text-ink"
            >
              <span className="text-[10px] font-medium tracking-[1.2px] text-ink-ghost">
                {row.kind.toLowerCase()}
              </span>
              {row.pct == null ? "—" : `${Math.round(row.pct)}%`}
            </span>
          ))}
        </div>
        {!clientsPending && mesh.length > 0 ? (
          <p className="truncate text-[11px] text-ink-ghost">
            {mesh.filter((c) => c.online).length}/{mesh.length} clients online
          </p>
        ) : null}
      </div>
    );
  }

  if (density === "cards") {
    return (
      <div
        ref={rootRef}
        className={`flex h-full min-h-0 flex-col gap-2.5 overflow-hidden px-3 pb-2.5 pt-1 ${className ?? ""}`}
      >
        <div className="min-w-0 rounded-[var(--radius)] border border-dashed border-rule/80 px-2.5 py-2">
          <p className="mb-1.5 text-[10px] font-medium tracking-[1.2px] text-ink-ghost">
            MODULES · {okCount}/{services.length}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {services.map((s) => (
              <span
                key={s.name}
                className={`rounded-[3px] px-1.5 py-0.5 font-mono text-[11px] ${
                  s.ok
                    ? "bg-sage/15 text-sage-deep"
                    : "bg-error/10 text-error"
                }`}
              >
                {s.name}
              </span>
            ))}
          </div>
        </div>

        <div className="min-w-0 rounded-[var(--radius)] border border-dashed border-rule/80 px-2.5 py-2">
          <p className="mb-1.5 text-[10px] font-medium tracking-[1.2px] text-ink-ghost">
            CLIENTS
          </p>
          {clientsPending ? (
            <p className="text-[12px] text-ink-ghost">Loading…</p>
          ) : mesh.length === 0 ? (
            <p className="text-[12px] text-ink-ghost">None on the mesh</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {mesh.map((c) => (
                <span
                  key={c.node_name}
                  className="inline-flex items-center gap-1.5 rounded-[3px] bg-rule/60 px-1.5 py-0.5 text-[11px] text-ink"
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      c.pending
                        ? "bg-sage"
                        : c.online
                          ? "bg-ink"
                          : "bg-ink-ghost"
                    }`}
                    aria-hidden
                  />
                  {c.node_name}
                </span>
              ))}
            </div>
          )}
        </div>

        {meters.length > 0 ? (
          <div className="mt-auto flex gap-2">
            {meters.map((row) => (
              <div
                key={row.key}
                className="min-w-0 flex-1 rounded-[var(--radius)] border border-dashed border-rule/80 px-2 py-1.5"
              >
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-[10px] font-medium tracking-[1.2px] text-ink-ghost">
                    {row.kind.toLowerCase()}
                  </span>
                  <span className="text-[11px] tabular-nums text-ink">
                    {row.pct == null ? "—" : `${Math.round(row.pct)}%`}
                  </span>
                </div>
                <div className="mt-1.5 h-[4px] overflow-hidden rounded-[2px] bg-rule">
                  {row.pct != null ? (
                    <div
                      className="h-full rounded-[2px] bg-sage"
                      style={{
                        width: `${Math.min(100, Math.max(0, row.pct))}%`,
                      }}
                    />
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`flex h-full min-h-0 flex-col overflow-hidden px-3.5 pb-2.5 pt-1 ${className ?? ""}`}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="mb-1.5 text-[11px] font-medium tracking-[1.2px] text-ink-ghost">
          MODULES
        </p>
        <ul className="flex flex-col gap-1">
          {services.map((s) => (
            <li key={s.name} className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px] text-ink">{s.name}</span>
              <span
                className={`text-[13px] ${s.ok ? "text-sage-deep" : "text-error"}`}
              >
                {s.ok ? "✓" : "✕"}
              </span>
            </li>
          ))}
        </ul>

        <p className="mb-1.5 mt-4 text-[11px] font-medium tracking-[1.2px] text-ink-ghost">
          CLIENTS
        </p>
        {clientsPending ? (
          <p className="text-[13px] text-ink-ghost">Loading…</p>
        ) : mesh.length === 0 ? (
          <p className="text-[13px] text-ink-ghost">None on the mesh</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {mesh.map((c) => (
              <li key={c.node_name} className="flex items-center gap-2.5">
                <span
                  className={`size-[7px] shrink-0 rounded-full ${
                    c.pending
                      ? "bg-sage"
                      : c.online
                        ? "bg-ink"
                        : "bg-ink-ghost"
                  }`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {c.node_name}
                </span>
                <span className="shrink-0 text-[12px] text-ink-ghost">
                  {clientLabel(c)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {meters.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2.5">
          {meters.map((row) => (
            <div key={row.key}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium tracking-[1.2px] text-ink-ghost">
                  {row.kind.toLowerCase()}
                </span>
                <span className="text-[12px] tabular-nums text-ink">
                  {row.pct == null ? "—" : `${Math.round(row.pct)}%`}
                </span>
              </div>
              <div className="h-[5px] overflow-hidden rounded-[3px] bg-rule">
                {row.pct != null ? (
                  <div
                    className="h-full rounded-[3px] bg-sage"
                    style={{
                      width: `${Math.min(100, Math.max(0, row.pct))}%`,
                    }}
                  />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ServiceRows({
  services,
}: {
  services: Array<{ name: string; ok: boolean }>;
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {services.map((s, i) => (
        <motion.li
          key={s.name}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: SLOW_S, ease: EASE, delay: i * 0.03 }}
          className="flex items-center justify-between gap-3 border-b border-dashed border-rule/80 py-2 last:border-b-0"
        >
          <span className="text-[13px] text-ink">{s.name}</span>
          <span
            className={`inline-flex items-center gap-1.5 text-[11px] tracking-wide ${
              s.ok ? "text-sage-deep" : "text-error"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                s.ok ? "bg-sage" : "bg-error"
              }`}
              aria-hidden
            />
            {s.ok ? "reachable" : "unreachable"}
          </span>
        </motion.li>
      ))}
    </ul>
  );
}

function ResourceMeters({ rows }: { rows: ResourceRow[] }) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row, i) => (
        <motion.li
          key={row.key}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: SLOW_S, ease: EASE, delay: i * 0.03 }}
          className="min-w-0"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium tracking-[2px] text-sage-deep">
              {row.kind}
            </span>
            {row.pct != null ? (
              <span className="shrink-0 text-[11px] tabular-nums text-ink-ghost">
                {Math.round(row.pct)}%
              </span>
            ) : (
              <span className="shrink-0 text-[11px] text-ink-ghost">—</span>
            )}
          </div>
          <p className="mt-0.5 min-w-0 truncate text-[12px] text-ink">{row.name}</p>
          {row.pct != null ? (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-rule">
              <div
                className="h-full rounded-full bg-sage transition-[width] duration-slow ease-hath"
                style={{ width: `${Math.min(100, Math.max(0, row.pct))}%` }}
              />
            </div>
          ) : null}
          {row.detail ? (
            <p className="mt-1.5 text-[11px] text-ink-muted">{row.detail}</p>
          ) : null}
        </motion.li>
      ))}
    </ul>
  );
}
