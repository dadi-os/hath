export type TerminalChipProps = {
  /** Most recent shell command, or null to show the terminal id. */
  command: string | null;
  /** Nas terminal id used as the fallback label. */
  terminalId: string;
  className?: string;
};

/** One-line chip for the agent's most recent host-terminal command. */
export function TerminalChip({ command, terminalId, className }: TerminalChipProps) {
  const trimmed = command?.replace(/\s+/g, " ").trim();
  const label = trimmed && trimmed.length > 0 ? trimmed : terminalId;
  return (
    <div
      className={`max-w-full truncate rounded-full border border-dashed border-sage-line bg-bone/85 px-2.5 py-1 font-mono text-[11px] text-ink-muted shadow-[var(--shadow)] ${className ?? ""}`}
      title={label}
    >
      {label}
    </div>
  );
}
