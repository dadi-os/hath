import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { motion } from "motion/react";
import {
  IconAttach,
  IconButton,
  IconCamera,
  IconDismiss,
  IconPlus,
  IconSend,
} from "../../../shared/components/IconButton";
import type { DraftAttachment } from "../../../shared/lib/content/attachments";
import { EASE, SLOW_S } from "../../../shared/lib/ux/motion";
import { TEXTAREA_MAX_PX } from "../constants";
import { LaneChip, type LaneChipLabel } from "../LaneChip";

export interface FloatingComposerProps {
  connected: boolean;
  draft: string;
  setDraft: (v: string) => void;
  placeholder: string;
  canSubmit: boolean;
  /** Conversation busy (thinking) — sends go to the local queue. */
  thinkingMode: boolean;
  /** Reasoning only (working); conversation free — send is live. */
  workingMode: boolean;
  /** Floating lane chip above the field; null when idle. */
  laneLabel: LaneChipLabel | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  cameraInputRef: RefObject<HTMLInputElement | null>;
  attachments: DraftAttachment[];
  onRemoveAttachment: (index: number) => void;
  onPickFiles: (files: FileList | null) => void;
  onSubmit: (e: FormEvent) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Focus the field once this composer mounts (Talk to Dadi). */
  autoFocus?: boolean;
  /** Reports the composer's rendered height as it grows or shrinks. */
  onHeight: (px: number) => void;
}

/**
 * Floating bottom composer — frosted with the rail, no highlight.
 */
export function FloatingComposer({
  connected,
  draft,
  setDraft,
  placeholder,
  canSubmit,
  thinkingMode,
  workingMode,
  laneLabel,
  textareaRef,
  fileInputRef,
  cameraInputRef,
  attachments,
  onRemoveAttachment,
  onPickFiles,
  onSubmit,
  onKeyDown,
  autoFocus = false,
  onHeight,
}: FloatingComposerProps) {
  const [attachOpen, setAttachOpen] = useState(false);
  const attachRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) {
      return;
    }
    const report = () => onHeight(Math.ceil(el.getBoundingClientRect().height));
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight]);

  useEffect(() => {
    if (!attachOpen) {
      return;
    }
    const onDoc = (e: MouseEvent) => {
      if (
        attachRef.current &&
        e.target instanceof Node &&
        !attachRef.current.contains(e.target)
      ) {
        setAttachOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [attachOpen]);

  useEffect(() => {
    if (!autoFocus) {
      return;
    }
    textareaRef.current?.focus();
  }, [autoFocus, textareaRef]);

  const attachDisabled = !connected;
  const status = !connected ? "Connect to message agent" : null;

  return (
    <motion.div
      ref={rootRef}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20"
      style={{
        paddingBottom: "max(0.65rem, env(safe-area-inset-bottom))",
      }}
      initial={{ opacity: 0 }}
      animate={{
        opacity: 1,
        transition: { duration: 0.16, delay: 0.24, ease: EASE },
      }}
      exit={{ opacity: 0, transition: { duration: 0.16, ease: EASE } }}
    >
      <div className="composer-fade" aria-hidden />
      <div className="relative z-10 px-3">
        <LaneChip label={laneLabel} />
        {status ? (
          <p className="pointer-events-none mb-1.5 px-1 text-center text-[11px] text-ink-ghost">
            {status}
          </p>
        ) : null}
        <form
          onSubmit={onSubmit}
          className={`composer-glass pointer-events-auto flex flex-col gap-2 px-2 py-2 transition-[opacity,box-shadow] duration-slow ease-hath ${
            workingMode && !thinkingMode ? "composer-glass--live" : ""
          } ${thinkingMode ? "composer-glass--thinking" : ""} ${
            connected ? "" : "opacity-70"
          }`}
        >
        {attachments.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto px-1.5 pt-1">
            {attachments.map((att, index) => (
              <motion.div
                key={`${att.filename ?? att.media_type}-${index}`}
                className="relative shrink-0"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: SLOW_S, ease: EASE }}
              >
                {att.previewUrl ? (
                  <img
                    src={att.previewUrl}
                    alt={att.filename ?? "attachment"}
                    className="h-14 w-14 rounded-[12px] object-cover"
                  />
                ) : (
                  <div className="flex h-14 max-w-[8rem] items-center rounded-[12px] border border-rule bg-sage-fill/30 px-2.5 text-[11px] leading-tight text-ink-muted">
                    <span className="truncate">{att.filename ?? "file"}</span>
                  </div>
                )}
                <button
                  type="button"
                  aria-label="Remove attachment"
                  onClick={() => onRemoveAttachment(index)}
                  className="absolute -right-1 -top-1 inline-flex size-5 items-center justify-center rounded-full bg-bone text-ink-muted shadow-[var(--shadow)]"
                >
                  <IconDismiss />
                </button>
              </motion.div>
            ))}
          </div>
        ) : null}
        <div className="flex items-end gap-1">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            onChange={(e) => {
              onPickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              onPickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <div ref={attachRef} className="relative mb-0.5">
            <IconButton
              type="button"
              label="Attach"
              size="lg"
              disabled={attachDisabled}
              className="border-transparent bg-transparent shadow-none backdrop-blur-none"
              onClick={() => setAttachOpen((open) => !open)}
            >
              <IconPlus />
            </IconButton>
            {attachOpen ? (
              <div className="composer-menu flex flex-col py-1">
                <button
                  type="button"
                  className="flex items-center gap-2 px-3 py-2 text-left text-[13px] text-ink hover:bg-sage-active/40"
                  onClick={() => {
                    setAttachOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <span className="size-4 text-sage-deep [&_svg]:size-full">
                    <IconAttach />
                  </span>
                  Attach file
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 px-3 py-2 text-left text-[13px] text-ink hover:bg-sage-active/40"
                  onClick={() => {
                    setAttachOpen(false);
                    cameraInputRef.current?.click();
                  }}
                >
                  <span className="size-4 text-sage-deep [&_svg]:size-full">
                    <IconCamera />
                  </span>
                  Take picture
                </button>
              </div>
            ) : null}
          </div>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={!connected}
            placeholder={connected ? placeholder : "Connect to message agent"}
            className={`block max-h-[160px] min-h-[40px] w-full flex-1 resize-none overflow-y-auto bg-transparent px-1 py-2.5 text-[15px] leading-snug outline-none placeholder:text-ink-ghost disabled:cursor-default ${
              thinkingMode ? "text-ink/70" : "text-ink"
            }`}
            style={{ maxHeight: TEXTAREA_MAX_PX }}
          />
          <motion.button
            type="submit"
            aria-label={thinkingMode ? "Queue message" : "Send"}
            title={thinkingMode ? "Queue message" : "Send"}
            disabled={!canSubmit}
            whileTap={canSubmit ? { scale: 0.94 } : undefined}
            transition={{ duration: 0.2, ease: EASE }}
            className={`mb-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full transition-colors duration-slow ease-hath [&_svg]:size-[17px] ${
              canSubmit
                ? "bg-[var(--ink)] text-[var(--bone)] hover:opacity-90"
                : "bg-transparent text-[var(--ink-muted)]"
            } disabled:cursor-default`}
          >
            <IconSend />
          </motion.button>
        </div>
      </form>
      </div>
    </motion.div>
  );
}
