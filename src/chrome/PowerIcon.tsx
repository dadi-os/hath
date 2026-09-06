import { useConnection } from "../hooks/useConnection";

type PowerIconProps = {
  className?: string;
};

export function PowerIcon({ className }: PowerIconProps) {
  const { state, toggle } = useConnection();

  const colorClass =
    state === "connected"
      ? "text-sage"
      : state === "connecting"
        ? "text-sage animate-breath"
        : "text-ink-ghost";

  return (
    <button
      type="button"
      onClick={() => {
        void toggle();
      }}
      aria-label={state === "disconnected" ? "Connect" : "Disconnect"}
      className={`inline-flex items-center justify-center p-1 transition-opacity duration-slow ease-hath ${colorClass} ${className ?? ""}`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M12 2v10"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M6.5 6.5a8 8 0 1 0 11 0"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
