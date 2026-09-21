export type DadiHomeProps = {
  /** Reserve space above the floating composer. */
  composerPad: number;
};

/**
 * Empty Talk-to-Dadi surface. Motion is owned by the sidebar stage so this
 * mark doesn't animate a second time on the way in or out.
 */
export function DadiHome({ composerPad }: DadiHomeProps) {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center px-8"
      style={{ paddingBottom: composerPad }}
    >
      <span className="font-gujarati text-[52px] leading-none text-sage-text">
        દાદી
      </span>
      <p className="mt-5 max-w-[14rem] text-center text-[13px] leading-relaxed tracking-[0.04em] text-ink-muted">
        Talk to Dadi about anything
      </p>
    </div>
  );
}
