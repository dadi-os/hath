import type { ReactNode } from "react";
import { motion } from "motion/react";
import { EASE } from "../lib/ux/motion";

export type IconButtonSize = "sm" | "md" | "lg";

export type IconButtonProps = {
  label: string;
  children: ReactNode;
  className?: string;
  /** sm chrome · md default · lg primary (e.g. send) */
  size?: IconButtonSize;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: () => void;
};

const SIZE: Record<
  IconButtonSize,
  { box: string; icon: string; radius: string }
> = {
  sm: {
    box: "size-7",
    icon: "[&_svg]:size-3.5",
    radius: "rounded-[6px]",
  },
  md: {
    box: "size-8",
    icon: "[&_svg]:size-4",
    radius: "rounded-[7px]",
  },
  lg: {
    box: "size-9",
    icon: "[&_svg]:size-[17px]",
    radius: "rounded-[var(--radius)]",
  },
};

/**
 * Compact icon control. Prefer size hierarchy over one loud default:
 * chrome back/home = sm, in-flow = md, primary send = lg.
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
  const s = SIZE[size];
  return (
    <motion.button
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      whileTap={disabled ? undefined : { scale: 0.94 }}
      transition={{ duration: 0.2, ease: EASE }}
      className={`inline-flex ${s.box} ${s.icon} ${s.radius} shrink-0 items-center justify-center border border-dashed border-sage-line bg-[var(--glass-sheet)] text-sage-deep shadow-[var(--shadow)] backdrop-blur-sm transition-[color,border-color,background-color,opacity] duration-slow ease-hath hover:border-sage hover:bg-sage-active/50 disabled:cursor-default disabled:border-rule disabled:text-ink-faint disabled:opacity-100 disabled:hover:border-rule disabled:hover:bg-[var(--glass-sheet)] ${className ?? ""}`}
    >
      {children}
    </motion.button>
  );
}

export function IconBack() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden>
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
    <svg viewBox="0 0 18 18" fill="none" aria-hidden>
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
    <svg viewBox="0 0 18 18" fill="none" aria-hidden>
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

export function IconAttach() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M15.2 8.4 9.1 14.5a3.6 3.6 0 0 1-5.1-5.1l6.5-6.5a2.4 2.4 0 0 1 3.4 3.4L7.4 12.8a1.2 1.2 0 1 1-1.7-1.7l5.4-5.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconCamera() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M3.2 6.2h2.1l1.1-1.6h5.2l1.1 1.6h2.1A1.5 1.5 0 0 1 16.3 7.7v6.1a1.5 1.5 0 0 1-1.5 1.5H3.2A1.5 1.5 0 0 1 1.7 13.8V7.7a1.5 1.5 0 0 1 1.5-1.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle
        cx="9"
        cy="10.4"
        r="2.35"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function IconRetry() {
  return (
    <svg viewBox="0 0 15 15" fill="none" aria-hidden className="size-[15px]">
      <path
        d="M12.2 7.2A4.7 4.7 0 1 1 10.6 3.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M10.2 1.6v2.6h2.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconDismiss() {
  return (
    <svg viewBox="0 0 15 15" fill="none" aria-hidden className="size-[15px]">
      <path
        d="M4 4l7 7M11 4l-7 7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconMenu() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M3.5 5h11M3.5 9h11M3.5 13h11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconNewChat() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M9 3.5v11M3.5 9h11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Power / leave-mesh glyph (24 viewBox; sized by parent). */
export function IconPower() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 2v10" />
      <path d="M6.2 5.2a8 8 0 1 0 11.6 0" />
    </svg>
  );
}
