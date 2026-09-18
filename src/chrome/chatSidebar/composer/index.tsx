import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
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

export interface FloatingComposerProps {
  connected: boolean;
  draft: string;
  setDraft: (v: string) => void;
  placeholder: string;
  canSubmit: boolean;
  /** Conversation lane held — sends go to the local draft queue. */
  holdMode: boolean;
  /** Reasoning working; conversation free — send is live. */
  workingMode: boolean;
  /** Who this composer is addressing. */
  targetName: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  cameraInputRef: RefObject<HTMLInputElement | null>;
  attachments: DraftAttachment[];
  onRemoveAttachment: (index: number) => void;
  onPickFiles: (files: FileList | null) => void;
  onSubmit: (e: FormEvent) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * Floating bottom composer. Hold mode queues; working mode keeps send live
 * while reasoning runs in the background. Disconnected keeps the same chrome,
 * disabled.
 */
export function FloatingComposer({
  connected,
  draft,
  setDraft,
  placeholder,
  canSubmit,
  holdMode,
  workingMode,
  targetName,
  textareaRef,
  fileInputRef,
  cameraInputRef,
  attachments,
  onRemoveAttachment,
  onPickFiles,
  onSubmit,
  onKeyDown,
}: FloatingComposerProps) {
  const [attachOpen, setAttachOpen] = useState(false);
  const attachRef = useRef<HTMLDivElement>(null);

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

  const attachDisabled = !connected;
  const status =
    !connected
      ? "Connect to message Dadi"
      : holdMode
        ? `Held for ${targetName}`
        : workingMode
          ? `${targetName} is thinking`
          : null;

  return (
    <motion.div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3"
      style={{
        paddingBottom: "max(0.65rem, env(safe-area-inset-bottom))",
      }}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      {status ? (
        <p className="pointer-events-none mb-1.5 px-1 text-center text-[11px] text-ink-ghost">
          {status}
        </p>
      ) : null}
      <form
        onSubmit={onSubmit}
        className={`pointer-events-auto flex flex-col gap-2 rounded-[26px] border px-2 py-2 shadow-[0_8px_28px_rgba(0,0,0,0.18)] transition-[border-color,background-color,box-shadow,opacity] duration-slow ease-hath ${
          holdMode
            ? "border-sage-line/40 bg-[var(--glass-sheet)]"
            : "border-[var(--glass-border)] bg-[var(--glass-sheet)]"
        } ${
          workingMode && !holdMode
            ? "shadow-[0_0_0_1px_color-mix(in_srgb,var(--sage)_34%,transparent),0_8px_28px_rgba(0,0,0,0.18)]"
            : ""
        } ${connected ? "" : "opacity-70"}`}
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
              className="border-transparent bg-transparent shadow-none"
              onClick={() => setAttachOpen((open) => !open)}
            >
              <IconPlus />
            </IconButton>
            {attachOpen ? (
              <div className="absolute bottom-[calc(100%+8px)] left-0 z-30 flex min-w-[11rem] flex-col overflow-hidden rounded-[14px] border border-[var(--glass-border)] bg-[var(--glass-sheet)] py-1 shadow-[var(--shadow-deep)]">
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
            placeholder={connected ? placeholder : "Connect to message Dadi"}
            className={`block max-h-[160px] min-h-[40px] w-full flex-1 resize-none overflow-y-auto bg-transparent px-1 py-2.5 text-[15px] leading-snug outline-none placeholder:text-ink-ghost disabled:cursor-default ${
              holdMode ? "text-ink/70" : "text-ink"
            }`}
            style={{ maxHeight: TEXTAREA_MAX_PX }}
          />
          <IconButton
            type="submit"
            label={holdMode ? "Queue message" : "Send"}
            disabled={!canSubmit}
            size="lg"
            className={`mb-0.5 rounded-full border-transparent shadow-none transition-[background-color,opacity,color] duration-slow ease-hath ${
              canSubmit
                ? "bg-ink text-bone hover:opacity-90"
                : "bg-transparent text-ink-ghost"
            }`}
          >
            <IconSend />
          </IconButton>
        </div>
      </form>
    </motion.div>
  );
}
