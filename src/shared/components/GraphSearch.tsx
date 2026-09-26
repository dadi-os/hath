export type GraphSearchProps = {
  value: string;
  onChange: (value: string) => void;
  /** Also the accessible name. */
  placeholder: string;
  /** Nodes matching the query; null while the query is empty. */
  matches: number | null;
  /** Enter pressed while exactly one node matches. */
  onPick: () => void;
};

/**
 * Search box pinned to the top-right of a graph space. The graph highlights and
 * frames the matches; with one match left it flies to that node. Escape clears.
 */
export function GraphSearch({ value, onChange, placeholder, matches, onPick }: GraphSearchProps) {
  return (
    <label className="pointer-events-auto absolute top-3 right-3 z-20 flex w-64 items-center gap-2 rounded-[var(--radius)] border border-rule bg-glass-sheet px-3 py-1.5 backdrop-blur-[var(--glass-blur)] transition-[border-color] duration-slow ease-hath focus-within:border-sage">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("");
          } else if (e.key === "Enter" && matches === 1) {
            onPick();
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-ghost [&::-webkit-search-cancel-button]:appearance-none"
      />
      {matches !== null ? (
        <span className="shrink-0 text-[10px] tracking-wide text-ink-ghost">
          {matches === 1 ? "1 match" : `${matches} matches`}
        </span>
      ) : null}
    </label>
  );
}
