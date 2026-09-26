import { IconDismiss, IconSearch } from "./IconButton";

export type SearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  /** Also the accessible name. */
  placeholder: string;
  /** Items matching the query; null while the query is empty. */
  matches: number | null;
  /** Enter pressed while exactly one item matches. */
  onPick: () => void;
};

/**
 * Page search box, rendered in the page header's trailing slot. Escape or the
 * clear button empties it; Enter with one match left picks that match.
 */
export function SearchField({ value, onChange, placeholder, matches, onPick }: SearchFieldProps) {
  return (
    <label className="flex h-9 w-80 items-center gap-2 rounded-[7px] border border-dashed border-sage-line bg-[var(--glass-sheet)] px-3 shadow-[var(--shadow)] backdrop-blur-[var(--glass-blur)] transition-[border-color,background-color] duration-slow ease-hath focus-within:border-sage focus-within:bg-sage-faint/60 hover:border-sage">
      <span className="flex size-4 shrink-0 text-ink-ghost">
        <IconSearch />
      </span>
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
        className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-ghost [&::-webkit-search-cancel-button]:appearance-none"
      />
      {matches !== null ? (
        <span
          className={`shrink-0 text-[10px] font-medium tracking-[1.2px] uppercase ${
            matches === 0 ? "text-ink-ghost" : "text-sage-deep"
          }`}
        >
          {matches === 1 ? "1 match" : `${matches} matches`}
        </span>
      ) : null}
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-ink-ghost transition-colors duration-slow ease-hath hover:bg-sage-active hover:text-sage-deep"
        >
          <IconDismiss />
        </button>
      ) : null}
    </label>
  );
}
