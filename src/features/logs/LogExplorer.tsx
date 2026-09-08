import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { nas } from "../../shared/api";
import type { NasLogEntry, NasLogLevel } from "../../shared/api/nas";
import { useConnection } from "../../hooks/useConnection";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";
import { POLL_MS } from "../../shared/lib/ux/poll";

export const LOG_SERVICES = [
  "dimaag",
  "yaad",
  "dwar",
  "nas",
  "hath",
  "caddy",
] as const;

export type RangePreset = "1h" | "6h" | "24h";

export type LogExplorerProps = {
  className?: string;
};

/** ISO from/to for a log range preset. Call per fetch so `to` stays current. */
export function rangeBounds(preset: RangePreset): { from: string; to: string } {
  const to = new Date();
  const hours = preset === "1h" ? 1 : preset === "6h" ? 6 : 24;
  const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function formatLogTime(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

function levelClass(level: string): string {
  const l = level.toLowerCase();
  if (l === "error") {
    return "text-[#9a5a4e]";
  }
  if (l === "warn") {
    return "text-sage-deep";
  }
  return "text-ink-ghost";
}

export type ErrorCardCopy = {
  /** Human-readable cause — shown as the primary line. */
  title: string;
  /** Short operational context (e.g. "reasoning lane failed"). */
  context: string | null;
  /** Provider/HTTP status when parseable. */
  code: number | null;
};

/**
 * Pull the nested human message out of Anthropic/SDK blobs like:
 * `Error code: 400 - {'type': 'error', 'error': {'message': 'Your credit…'}}`
 * Prefers the innermost quoted `message` value, then embedded JSON, then stripped text.
 */
function humanizeProviderBlob(text: string): {
  message: string;
  code: number | null;
} {
  const codeMatch = text.match(/\b(?:Error code|status(?:Code)?):\s*(\d{3})\b/i);
  const code = codeMatch ? Number(codeMatch[1]) : null;

  const messageMatches = [
    ...text.matchAll(/['"]message['"]\s*:\s*['"]([^'"]+)['"]/g),
  ];
  if (messageMatches.length > 0) {
    const innermost = messageMatches[messageMatches.length - 1]?.[1];
    if (innermost) {
      return { message: innermost, code };
    }
  }

  const jsonStart = text.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const asJson = text
        .slice(jsonStart)
        .replace(/'/g, '"')
        .replace(/\bNone\b/g, "null")
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false");
      const parsed = JSON.parse(asJson) as {
        error?: { message?: string };
        message?: string;
      };
      const nested = parsed.error?.message ?? parsed.message;
      if (nested) {
        return { message: nested, code };
      }
    } catch {}
  }

  const stripped = text.replace(/^Error code:\s*\d+\s*-\s*/i, "").trim();
  return { message: stripped || text, code };
}

/**
 * Prefer a clean human cause over raw SDK / provider dump strings.
 */
export function errorCardCopy(entry: NasLogEntry): ErrorCardCopy {
  const context = entry.msg?.trim() || null;
  let blob: string | null = null;

  if (entry.raw) {
    try {
      const parsed = JSON.parse(entry.raw) as {
        err?: { message?: string; statusCode?: number };
        error?: string;
      };
      blob = parsed.err?.message ?? parsed.error ?? null;
    } catch {
      blob = null;
    }
  }

  if (blob) {
    const { message, code } = humanizeProviderBlob(blob);
    if (message && message !== context) {
      return { title: message, context, code };
    }
    return { title: context ?? message, context: null, code };
  }

  return { title: context ?? "error", context: null, code: null };
}

function formatCardTime(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

const RANGE_PRESETS: RangePreset[] = ["1h", "6h", "24h"];

const SEVERITY_OPTIONS: Array<{
  value: NasLogLevel | "";
  label: string;
}> = [
  { value: "", label: "Any" },
  { value: "error", label: "Error" },
  { value: "warn", label: "Warn" },
  { value: "info", label: "Info" },
  { value: "debug", label: "Debug" },
];

/** Health probes and HTTP access chatter — not useful in the explorer. */
function isNoiseLog(entry: NasLogEntry): boolean {
  const msg = entry.msg.trim().toLowerCase();
  if (msg === "request completed" || msg === "incoming request") {
    return true;
  }
  if (/get \/health/i.test(entry.msg)) {
    return true;
  }
  if (entry.raw) {
    if (/\/health/.test(entry.raw) && /"(GET|get)"/.test(entry.raw)) {
      return true;
    }
  }
  return false;
}

function RangeChips({
  value,
  onChange,
}: {
  value: RangePreset;
  onChange: (v: RangePreset) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="inline-flex shrink-0 gap-1"
    >
      {RANGE_PRESETS.map((p) => {
        const on = value === p;
        return (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(p)}
            className={`rounded-[6px] border border-dashed px-2.5 py-1 text-[11px] tracking-wide transition-colors duration-slow ease-hath ${
              on
                ? "border-sage bg-sage-active text-sage-deep"
                : "border-rule text-ink-ghost hover:border-sage-line"
            }`}
          >
            {p}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Shared pill track with a sliding thumb — distinct from discrete chip toggles.
 */
function SeverityGlider({
  value,
  onChange,
}: {
  value: NasLogLevel | "";
  onChange: (v: NasLogLevel | "") => void;
}) {
  const index = Math.max(
    0,
    SEVERITY_OPTIONS.findIndex((o) => o.value === value),
  );
  const n = SEVERITY_OPTIONS.length;

  return (
    <div
      role="radiogroup"
      aria-label="Severity"
      className="relative inline-grid shrink-0 grid-cols-5 rounded-full bg-sage-fill p-0.5"
    >
      <motion.div
        className="absolute inset-y-0.5 rounded-full bg-bone shadow-[var(--shadow)] ring-1 ring-sage-line/80"
        initial={false}
        animate={{
          left: `calc(${index} * 100% / ${n} + 2px)`,
          width: `calc(100% / ${n} - 4px)`,
        }}
        transition={{ duration: SLOW_S, ease: EASE }}
      />
      {SEVERITY_OPTIONS.map((opt) => {
        const on = value === opt.value;
        return (
          <button
            key={opt.value || "any"}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(opt.value)}
            className={`relative z-10 min-w-[2.75rem] px-2.5 py-1 text-[11px] tracking-wide transition-colors duration-slow ease-hath ${
              on ? "text-sage-deep" : "text-ink-ghost hover:text-ink-muted"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Nas GET /logs explorer: modules, severity + range, then search.
 */
export function LogExplorer({ className }: LogExplorerProps) {
  const { state: connection } = useConnection();
  const connected = connection === "connected";

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState<NasLogLevel | "">("");
  const [qDraft, setQDraft] = useState("");
  const [q, setQ] = useState("");
  const [range, setRange] = useState<RangePreset>("1h");

  const servicesParam =
    selected.size > 0 ? [...selected].sort().join(",") : undefined;

  const logsQuery = useQuery({
    queryKey: ["nas", "logs", servicesParam ?? "", level, q, range],
    queryFn: () => {
      const { from, to } = rangeBounds(range);
      return nas.getLogs({
        services: servicesParam,
        level: level || undefined,
        q: q || undefined,
        from,
        to,
        limit: 200,
      });
    },
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const toggleService = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const entries = useMemo(() => {
    const raw = logsQuery.data?.entries ?? [];
    if (q && /request completed|incoming request|\/health/i.test(q)) {
      return raw;
    }
    return raw.filter((e) => !isNoiseLog(e));
  }, [logsQuery.data?.entries, q]);

  if (!connected) {
    return (
      <div className={`flex h-full items-center justify-center ${className ?? ""}`}>
        <p className="text-[13px] text-ink-ghost">Connect to search logs</p>
      </div>
    );
  }

  return (
    <div className={`flex h-full min-h-0 flex-col gap-3 ${className ?? ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        {LOG_SERVICES.map((name) => {
          const on = selected.has(name);
          return (
            <button
              key={name}
              type="button"
              onClick={() => toggleService(name)}
              className={`rounded-[6px] border border-dashed px-2 py-1 text-[11px] tracking-wide transition-colors duration-slow ease-hath ${
                on
                  ? "border-sage bg-sage-active text-sage-deep"
                  : "border-rule text-ink-ghost hover:border-sage-line"
              }`}
            >
              {name}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SeverityGlider value={level} onChange={setLevel} />
        <RangeChips value={range} onChange={setRange} />
      </div>

      <form
        className="flex min-w-0 gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(qDraft.trim());
        }}
      >
        <input
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          placeholder="Filter message…"
          className="min-w-0 flex-1 rounded-[6px] border border-dashed border-sage-line bg-bone px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-ghost focus:border-sage"
        />
        <button
          type="submit"
          className="rounded-[6px] border border-dashed border-sage-line bg-sage-fill px-2.5 py-1.5 text-[11px] font-medium text-sage-deep"
        >
          Search
        </button>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-[var(--radius)] border border-dashed border-rule">
        {logsQuery.isLoading ? (
          <p className="px-3 py-6 text-[13px] text-ink-ghost">Loading logs…</p>
        ) : logsQuery.isError ? (
          <p className="px-3 py-6 text-[13px] text-ink-muted">
            Could not load logs.
          </p>
        ) : entries.length === 0 ? (
          <p className="px-3 py-6 text-[13px] text-ink-ghost">No log lines</p>
        ) : (
          <ul className="divide-y divide-rule/80">
            {entries.map((entry, i) => (
              <motion.li
                key={`${entry.time}-${entry.service}-${i}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{
                  duration: SLOW_S,
                  ease: EASE,
                  delay: Math.min(i * 0.01, 0.15),
                }}
                className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3"
              >
                <span className="shrink-0 text-[11px] tabular-nums text-ink-ghost">
                  {formatLogTime(entry.time)}
                </span>
                <span className="shrink-0 text-[11px] font-medium tracking-wide text-sage-text">
                  {entry.service || "—"}
                </span>
                <span
                  className={`shrink-0 text-[10px] uppercase tracking-wider ${levelClass(entry.level)}`}
                >
                  {entry.level}
                </span>
                <span className="min-w-0 flex-1 break-words text-[12px] leading-snug text-ink">
                  {entry.msg}
                </span>
              </motion.li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export type ErrorLogCardsProps = {
  className?: string;
  /** Max cards to show. */
  limit?: number;
};

/**
 * Recent error lines as cards — used on the System page in place of uptime.
 */
export function ErrorLogCards({ className, limit = 8 }: ErrorLogCardsProps) {
  const { state: connection } = useConnection();
  const connected = connection === "connected";

  const errorsQuery = useQuery({
    queryKey: ["nas", "logs", "errors", limit],
    queryFn: () => {
      const { from, to } = rangeBounds("1h");
      return nas.getLogs({
        level: "error",
        from,
        to,
        limit,
      });
    },
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  if (!connected) {
    return (
      <div className={className}>
        <p className="text-[13px] text-ink-ghost">Connect to load errors</p>
      </div>
    );
  }

  if (errorsQuery.isError) {
    return (
      <div className={className}>
        <p className="text-[13px] text-ink-muted">Could not load errors.</p>
      </div>
    );
  }

  const entries = errorsQuery.data?.entries ?? [];

  return (
    <div className={`flex flex-col gap-3 ${className ?? ""}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium tracking-[2px] text-sage-deep">
          ERRORS
        </span>
        <span className="text-[11px] text-ink-ghost">
          {errorsQuery.isLoading ? "…" : `${entries.length} · last hour`}
        </span>
      </div>

      {errorsQuery.isLoading ? (
        <p className="text-[13px] text-ink-ghost">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="rounded-[var(--radius)] border border-dashed border-sage-line bg-sage-fill/40 px-3 py-4 text-[13px] text-ink-ghost">
          No errors in the last hour
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {entries.map((entry, i) => {
            const { title, context, code } = errorCardCopy(entry);
            return (
              <motion.li
                key={`${entry.time}-${entry.service}-${i}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: SLOW_S,
                  ease: EASE,
                  delay: Math.min(i * 0.03, 0.2),
                }}
                className="min-w-0 overflow-hidden rounded-[var(--radius)] border border-dashed border-[#c4a49a] bg-[#f7f0ed]/60 px-3 py-2.5"
              >
                <div className="flex min-w-0 items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-[11px] font-medium tracking-wide text-[#9a5a4e]">
                    {entry.service || "unknown"}
                    {code != null ? (
                      <span className="ml-1.5 font-normal text-ink-ghost">
                        · {code}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-ink-ghost">
                    {formatCardTime(entry.time)}
                  </span>
                </div>
                <p className="mt-1.5 min-w-0 overflow-hidden text-[13px] leading-snug text-ink [overflow-wrap:anywhere] line-clamp-3">
                  {title}
                </p>
                {context ? (
                  <p className="mt-1 min-w-0 truncate text-[11px] leading-snug text-ink-muted">
                    {context}
                  </p>
                ) : null}
              </motion.li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
