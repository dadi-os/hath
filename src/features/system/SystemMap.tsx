import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import { nas } from "../../api";
import type { NasLogEntry, NasStatus } from "../../api/nas";
import {
  errorCardCopy,
  ErrorLogCards,
  rangeBounds,
} from "../logs/LogExplorer";
import { useConnection } from "../../hooks/useConnection";
import { EASE, SLOW_S } from "../../shared/motion";

export type SystemMapProps = {
  mode: "full" | "preview";
  className?: string;
};

const SERVICE_ORDER = ["nas", "dimaag", "yaad", "dwar", "hath"] as const;

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

function diskPct(status: NasStatus): number {
  if (status.disk.total_bytes <= 0) {
    return 0;
  }
  return Math.min(
    100,
    (1 - status.disk.free_bytes / status.disk.total_bytes) * 100,
  );
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
  if (status.disk.total_bytes > 0) {
    rows.push({
      key: "disk",
      kind: "DISK",
      name: "Root volume",
      pct: diskPct(status),
      detail: `${formatBytes(status.disk.free_bytes)} free of ${formatBytes(status.disk.total_bytes)}`,
    });
  }
  return rows;
}

/**
 * Box health + recent errors. Preview is dynamic: quiet pulse when clear,
 * latest error when something failed. Full mode is the left health column.
 */
export function SystemMap({ mode, className }: SystemMapProps) {
  const { state: connection } = useConnection();
  const connected = connection === "connected";
  const preview = mode === "preview";
  const errorBounds = useMemo(() => rangeBounds("1h"), []);

  const statusQuery = useQuery({
    queryKey: ["nas", "status"],
    queryFn: () => nas.getStatus(),
    enabled: connected,
    refetchInterval: 5_000,
  });

  const errorsQuery = useQuery({
    queryKey: ["nas", "logs", "errors-preview", errorBounds.from],
    queryFn: () =>
      nas.getLogs({
        level: "error",
        from: errorBounds.from,
        to: errorBounds.to,
        limit: preview ? 8 : 4,
      }),
    enabled: connected,
    refetchInterval: 20_000,
  });

  if (!connected) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">Connect to load system</p>
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
  const errors = errorsQuery.data?.entries ?? [];
  const downCount = services.filter((s) => !s.ok).length;

  if (preview) {
    return (
      <SystemPreview
        className={className}
        services={services}
        resources={resources}
        errors={errors}
        errorsLoading={errorsQuery.isLoading}
        downCount={downCount}
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

function SystemPreview({
  className,
  services,
  resources,
  errors,
  errorsLoading,
  downCount,
}: {
  className?: string;
  services: Array<{ name: string; ok: boolean }>;
  resources: ResourceRow[];
  errors: NasLogEntry[];
  errorsLoading: boolean;
  downCount: number;
}) {
  const hasErrors = errors.length > 0;
  const latest = hasErrors ? errors[0] : null;
  const copy = latest ? errorCardCopy(latest) : null;
  const compactResources = resources.filter((r) => r.pct != null).slice(0, 3);

  return (
    <div
      className={`flex h-full min-h-0 flex-col overflow-hidden px-3.5 pb-2.5 pt-1 ${className ?? ""}`}
    >
      <div className="flex flex-wrap gap-1.5">
        {services.map((s) => (
          <span
            key={s.name}
            className={`inline-flex items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 text-[10px] tracking-wide ${
              s.ok ? "text-ink-ghost" : "bg-[#f7f0ed] text-[#9a5a4e]"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                s.ok ? "bg-sage" : "bg-[#9a5a4e]"
              }`}
              aria-hidden
            />
            {s.name}
          </span>
        ))}
      </div>

      <div className="relative mt-3 min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {errorsLoading ? (
            <motion.p
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-[12px] text-ink-ghost"
            >
              Checking…
            </motion.p>
          ) : hasErrors && copy ? (
            <motion.div
              key="errors"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: SLOW_S, ease: EASE }}
              className="flex h-full min-w-0 flex-col overflow-hidden"
            >
              <p className="text-[10px] font-medium tracking-[1.5px] text-[#9a5a4e]">
                {errors.length} ERROR{errors.length === 1 ? "" : "S"} · 1H
              </p>
              <p className="mt-2 min-w-0 overflow-hidden text-[13px] leading-snug text-ink [overflow-wrap:anywhere] line-clamp-3">
                {copy.title}
              </p>
              {copy.context ? (
                <p className="mt-1 min-w-0 truncate text-[11px] text-ink-muted">
                  {latest?.service}
                  {copy.code != null ? ` · ${copy.code}` : ""}
                  {" · "}
                  {copy.context}
                </p>
              ) : (
                <p className="mt-1 truncate text-[11px] text-ink-muted">
                  {latest?.service}
                  {copy.code != null ? ` · ${copy.code}` : ""}
                </p>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="quiet"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: SLOW_S, ease: EASE }}
              className="flex h-full flex-col justify-center"
            >
              <p className="text-[15px] text-ink">
                {downCount > 0 ? "Degraded" : "All clear"}
              </p>
              <p className="mt-1 text-[12px] text-ink-ghost">
                {downCount > 0
                  ? `${downCount} service${downCount === 1 ? "" : "s"} unreachable`
                  : "No errors in the last hour"}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {compactResources.length > 0 ? (
        <div className="mt-auto flex flex-wrap gap-x-3 gap-y-1 pt-2 text-[10px] text-ink-ghost">
          {compactResources.map((r) => (
            <span key={r.key} className="tabular-nums">
              {r.kind.toLowerCase()} {Math.round(r.pct ?? 0)}%
            </span>
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
              s.ok ? "text-sage-deep" : "text-[#9a5a4e]"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                s.ok ? "bg-sage" : "bg-[#9a5a4e]"
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
