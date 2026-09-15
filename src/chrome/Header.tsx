import { useNavigate } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "../shared/api/runtime";
import { detectDesktopOs } from "../target";
import { WindowControls } from "./WindowControls";

/** Toggle maximize on the current Tauri window; no-op outside the desktop shell. */
function toggleMaximize() {
  if (!isTauriRuntime()) {
    return;
  }
  void getCurrentWindow().toggleMaximize();
}

/** Short desktop title bar — centered wordmark, drag regions, window chrome. */
export function Header() {
  const navigate = useNavigate();
  const desktopOs = detectDesktopOs();
  const frameless = desktopOs === "windows" || desktopOs === "linux";
  const pad =
    desktopOs === "macos"
      ? "pl-[80px] pr-3"
      : frameless
        ? "pl-3 pr-0"
        : "px-4";

  return (
    <header
      className={`titlebar relative flex h-8 shrink-0 items-stretch select-none ${pad}`}
    >
      <div
        className="titlebar-drag min-h-0 min-w-[24px] flex-1"
        data-tauri-drag-region
        onDoubleClick={toggleMaximize}
      />
      <button
        type="button"
        onClick={() => navigate("/")}
        className="absolute inset-y-0 left-1/2 z-10 flex -translate-x-1/2 items-center"
        aria-label="Dadi home"
      >
        <span className="font-gujarati text-[18px] leading-none text-sage-text">
          દાદી
        </span>
      </button>
      <div
        className="titlebar-drag min-h-0 min-w-[24px] flex-1"
        data-tauri-drag-region
        onDoubleClick={toggleMaximize}
      />
      {frameless ? <WindowControls /> : null}
    </header>
  );
}
