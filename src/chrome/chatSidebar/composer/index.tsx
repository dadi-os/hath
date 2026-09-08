import type { FormEvent, KeyboardEvent, RefObject } from "react";
import { motion } from "motion/react";
import {
  IconAttach,
  IconButton,
  IconCamera,
  IconDismiss,
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
 * while reasoning runs in the background.
 */
export function FloatingComposer({
  connected,
  draft,
  setDraft,
  placeholder,
  canSubmit,
  holdMode,
  workingMode,
  textareaRef,
  fileInputRef,
  cameraInputRef,
  attachments,
  onRemoveAttachment,
  onPickFiles,
  onSubmit,
  onKeyDown,
}: FloatingComposerProps) {
  return (
    <motion.div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3"
      style={{
        paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))",
      }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      {connected ? (
        <form
          onSubmit={onSubmit}
          className={`pointer-events-auto flex flex-col gap-1.5 rounded-[var(--radius)] border border-dashed px-2 py-1.5 shadow-[var(--shadow)] backdrop-blur-md transition-[border-color,background-color] duration-slow ease-hath ${
            holdMode
              ? "border-sage-line/70 bg-sage-fill/35"
              : workingMode
                ? "border-sage/50 bg-bone/92"
                : "border-sage-line bg-bone/92"
          }`}
        >
          {attachments.length > 0 ? (
            <div className="flex gap-1.5 overflow-x-auto px-0.5 pt-0.5">
              {attachments.map((att, index) => (
                <div
                  key={`${att.filename ?? att.media_type}-${index}`}
                  className="relative shrink-0"
                >
                  {att.previewUrl ? (
                    <img
                      src={att.previewUrl}
                      alt={att.filename ?? "attachment"}
                      className="h-12 w-12 rounded-[6px] object-cover"
                    />
                  ) : (
                    <div className="flex h-12 max-w-[7rem] items-center rounded-[6px] border border-dashed border-sage-line bg-sage-fill/30 px-2 text-[10px] leading-tight text-ink-muted">
                      <span className="truncate">{att.filename ?? "file"}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label="Remove attachment"
                    onClick={() => onRemoveAttachment(index)}
                    className="absolute -right-1 -top-1 inline-flex size-4 items-center justify-center rounded-full bg-bone text-ink-muted shadow-[var(--shadow)]"
                  >
                    <IconDismiss />
                  </button>
                </div>
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
            <IconButton
              type="button"
              label="Attach file"
              size="md"
              className="mb-px border-transparent bg-transparent shadow-none"
              onClick={() => fileInputRef.current?.click()}
            >
              <IconAttach />
            </IconButton>
            <IconButton
              type="button"
              label="Take photo"
              size="md"
              className="mb-px border-transparent bg-transparent shadow-none"
              onClick={() => cameraInputRef.current?.click()}
            >
              <IconCamera />
            </IconButton>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={placeholder}
              className={`block max-h-[88px] min-h-[32px] w-full flex-1 resize-none overflow-y-auto bg-transparent px-1.5 py-1.5 text-[13px] leading-snug outline-none placeholder:text-ink-ghost ${
                holdMode ? "text-ink/70" : "text-ink"
              }`}
              style={{ maxHeight: TEXTAREA_MAX_PX }}
            />
            <IconButton
              type="submit"
              label={holdMode ? "Queue message" : "Send"}
              disabled={!canSubmit}
              size="lg"
              className={`mb-px border-sage-line bg-sage-fill ${
                workingMode && !holdMode
                  ? "shadow-[0_0_0_1px_rgba(143,163,130,0.35)]"
                  : ""
              }`}
            >
              <IconSend />
            </IconButton>
          </div>
        </form>
      ) : (
        <div className="pointer-events-auto rounded-[var(--radius)] border border-dashed border-sage-line bg-bone/92 px-3 py-2 text-[13px] text-ink-ghost shadow-[var(--shadow)] backdrop-blur-md">
          Connect to message Dadi
        </div>
      )}
    </motion.div>
  );
}
