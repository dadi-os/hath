import type { ReactNode } from "react";
import { motion } from "motion/react";
import { EASE } from "./motion";

export type IconButtonProps = {
  label: string;
  children: ReactNode;
  className?: string;
  size?: "md" | "lg";
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: () => void;
};

/**
 * Large hit-target control with a distinctive glyph — prefer this over tiny text links.
 */
export function IconButton({
  label,
  children,
  className,
  size = "md",
  disabled,
  type = "button",
  onClick,
}: IconButtonProps) {
  const dim = size === "lg" ? "size-11" : "size-10";
  return (
    <motion.button
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      whileTap={disabled ? undefined : { scale: 0.94 }}
      transition={{ duration: 0.2, ease: EASE }}
      className={`inline-flex ${dim} shrink-0 items-center justify-center rounded-[var(--radius)] border border-dashed border-sage-line bg-bone text-sage-deep shadow-[var(--shadow)] transition-colors duration-slow ease-hath hover:border-sage hover:bg-sage-active/50 disabled:opacity-35 ${className ?? ""}`}
    >
      {children}
    </motion.button>
  );
}

export function IconBack() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M11.5 3.5 6 9l5.5 5.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconHome() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M3 8.2 9 3l6 5.2V15a1 1 0 0 1-1 1h-3.2v-4.2H7.2V16H4a1 1 0 0 1-1-1V8.2Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconSend() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M3.2 9h11.2M10.2 4.5 14.5 9l-4.3 4.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
