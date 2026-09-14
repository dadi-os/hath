import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "../shared/api/runtime";

/**
 * Frameless window controls for Windows/Linux. Mac keeps native traffic lights.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    void win.isMaximized().then(setMaximized);
    void win
      .onResized(() => {
        void win.isMaximized().then(setMaximized);
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, []);

  if (!isTauriRuntime()) {
    return null;
  }

  return (
    <div className="window-controls flex shrink-0 items-stretch self-stretch">
      <ControlButton
        label="Minimize"
        onClick={() => {
          void getCurrentWindow().minimize();
        }}
      >
        <IconMinimize />
      </ControlButton>
      <ControlButton
        label={maximized ? "Restore" : "Maximize"}
        onClick={() => {
          void getCurrentWindow().toggleMaximize();
        }}
      >
        {maximized ? <IconRestore /> : <IconMaximize />}
      </ControlButton>
      <ControlButton
        label="Close"
        danger
        onClick={() => {
          void getCurrentWindow().close();
        }}
      >
        <IconClose />
      </ControlButton>
    </div>
  );
}

type ControlButtonProps = {
  /** Accessible name for the control. */
  label: string;
  children: ReactNode;
  /** Close-button styling (red hover). */
  danger?: boolean;
  onClick: () => void;
};

/** Single caption-button cell in the frameless window chrome. */
function ControlButton({
  label,
  children,
  danger,
  onClick,
}: ControlButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex w-[46px] items-center justify-center text-ink-muted transition-[background-color,color] duration-fast ease-hath ${
        danger
          ? "hover:bg-[#c45c4a] hover:text-white"
          : "hover:bg-sage-fill hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function IconMinimize() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <path
        d="M1 5h8"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMaximize() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <rect
        x="1.25"
        y="1.25"
        width="7.5"
        height="7.5"
        rx="0.5"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function IconRestore() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <path
        d="M3 3.5h4.25V7.75"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <rect
        x="1.25"
        y="2.75"
        width="5.5"
        height="5.5"
        rx="0.5"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <path
        d="M2.25 2.25 7.75 7.75M7.75 2.25 2.25 7.75"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}
