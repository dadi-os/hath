export type GraphPlaceholderProps = {
  /** `loading` breathes; `empty` and `offline` draw a hollow sketch; `error` marks the hub. */
  tone: "loading" | "empty" | "offline" | "error";
  /** Short tracking label, e.g. "Loading Yaad". */
  label: string;
  /** One quiet line under the label. For `error`, the server's message. */
  detail?: string;
};

const HUB = { x: 90, y: 60, r: 6 };

const SATELLITES = [
  { x: 38, y: 34, r: 4 },
  { x: 62, y: 16, r: 2.5 },
  { x: 140, y: 26, r: 3.5 },
  { x: 152, y: 80, r: 4.5 },
  { x: 106, y: 104, r: 3.5 },
  { x: 32, y: 90, r: 3 },
] as const;

const CROSS_LINKS = [
  [0, 1],
  [3, 4],
] as const;

/**
 * Stand-in for a knowledge or agent graph before there is a graph to draw:
 * a small constellation in the graph's own palette with a tracking label.
 */
export function GraphPlaceholder({ tone, label, detail }: GraphPlaceholderProps) {
  const live = tone === "loading";
  const node = tone === "offline" ? "var(--ink-ghost)" : live ? "var(--sage)" : "var(--sage-line)";
  const hub =
    tone === "error" ? "var(--error)" : tone === "offline" ? "var(--ink-ghost)" : "var(--sage-deep)";
  const link = tone === "offline" ? "var(--ink-ghost)" : "var(--sage-line)";

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live="polite"
      className="flex h-full w-full flex-col items-center justify-center gap-4 px-4 text-center"
    >
      <svg viewBox="0 0 180 120" className="w-[min(11rem,45%)] overflow-visible" aria-hidden>
        <g stroke={link} strokeWidth="1" strokeDasharray={live ? undefined : "3 4"} opacity={live ? 0.9 : 0.7}>
          {SATELLITES.map((sat) => (
            <line key={`${sat.x}-${sat.y}`} x1={HUB.x} y1={HUB.y} x2={sat.x} y2={sat.y} />
          ))}
          {CROSS_LINKS.map(([a, b]) => (
            <line
              key={`${a}-${b}`}
              x1={SATELLITES[a].x}
              y1={SATELLITES[a].y}
              x2={SATELLITES[b].x}
              y2={SATELLITES[b].y}
            />
          ))}
        </g>
        {SATELLITES.map((sat, i) => (
          <circle
            key={`${sat.x}-${sat.y}`}
            cx={sat.x}
            cy={sat.y}
            r={sat.r}
            fill={live ? node : "var(--bone)"}
            stroke={node}
            strokeWidth={live ? 0 : 1}
            strokeDasharray={live ? undefined : "2 2"}
            className={live ? "animate-breath" : undefined}
            style={live ? { animationDelay: `${i * 260}ms` } : undefined}
          />
        ))}
        <circle
          cx={HUB.x}
          cy={HUB.y}
          r={HUB.r}
          fill={live || tone === "error" ? hub : "var(--bone)"}
          stroke={hub}
          strokeWidth={live ? 0 : 1.2}
          strokeDasharray={tone === "empty" || tone === "offline" ? "2.5 2" : undefined}
          className={live ? "animate-breath" : undefined}
        />
      </svg>
      <div className="flex flex-col items-center gap-1.5">
        <span
          className={`text-[11px] font-medium tracking-[2.5px] uppercase ${
            tone === "error" ? "text-error" : tone === "offline" ? "text-ink-ghost" : "text-sage-deep"
          }`}
        >
          {label}
        </span>
        {detail ? (
          <p className="max-w-xs text-[12px] leading-relaxed text-ink-ghost">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}
