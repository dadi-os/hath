import { motion } from "motion/react";
import { useState, type FormEvent } from "react";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";

export type LoginEditorValues = {
  name: string;
  username: string;
  uri: string;
  /** Empty on edit means leave the stored password unchanged. */
  password: string;
};

export type LoginEditorProps = {
  mode: "create" | "edit";
  initial?: {
    name: string;
    username: string;
    uri: string;
  };
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (values: LoginEditorValues) => void;
};

const fieldClass =
  "w-full rounded-[var(--radius)] border border-rule bg-bone/50 px-3 py-2 text-[14px] text-ink outline-none transition-[border-color] duration-slow ease-hath placeholder:text-ink-ghost focus:border-sage disabled:opacity-50";

/**
 * Create / edit login sheet. On edit, an empty password leaves the vault value alone.
 */
export function LoginEditor({
  mode,
  initial,
  pending,
  error,
  onClose,
  onSubmit,
}: LoginEditorProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [uri, setUri] = useState(initial?.uri ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const canSubmit =
    name.trim().length > 0 &&
    username.trim().length > 0 &&
    !pending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      return;
    }
    onSubmit({
      name: name.trim(),
      username: username.trim(),
      uri: uri.trim(),
      password,
    });
  };

  return (
    <motion.div
      className="frost-scrim absolute inset-0 z-20 flex items-end justify-center p-3 sm:items-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
      onClick={onClose}
    >
      <motion.form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: SLOW_S, ease: EASE }}
        className="widget-frame flex w-full max-w-md flex-col shadow-[var(--shadow-deep)]"
      >
        <div className="widget-frame__chrome !justify-between !px-4 !pt-3 !pb-2">
          <span className="widget-frame__title">
            {mode === "create" ? "New login" : "Edit login"}
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="text-[10px] font-medium tracking-[1.6px] text-ink-ghost hover:text-ink-muted disabled:opacity-40"
          >
            CLOSE
          </button>
        </div>
        <div className="widget-frame__body flex flex-col gap-3 px-4 pb-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium tracking-[2px] text-ink-ghost">
              NAME
            </span>
            <input
              className={fieldClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium tracking-[2px] text-ink-ghost">
              USERNAME
            </span>
            <input
              className={fieldClass}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              spellCheck={false}
              disabled={pending}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium tracking-[2px] text-ink-ghost">
              WEBSITE
            </span>
            <input
              className={fieldClass}
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              placeholder="https://"
              autoComplete="url"
              spellCheck={false}
              disabled={pending}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium tracking-[2px] text-ink-ghost">
              PASSWORD
              {mode === "edit" ? " (leave blank to keep)" : " (optional — generate if empty)"}
            </span>
            <div className="flex gap-2">
              <input
                className={`${fieldClass} font-mono`}
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                disabled={pending}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="shrink-0 rounded-[var(--radius)] border border-dashed border-sage-line px-2.5 text-[10px] font-medium tracking-[1.4px] text-sage-deep hover:border-sage"
              >
                {showPassword ? "HIDE" : "SHOW"}
              </button>
            </div>
          </label>
          {error ? (
            <p className="text-[12px] text-[var(--error)]">{error}</p>
          ) : null}
          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-1 rounded-[var(--radius)] bg-sage-fill px-3 py-2.5 text-[12px] font-medium tracking-[2px] text-sage-deep disabled:opacity-40"
          >
            {pending
              ? mode === "create"
                ? "CREATING…"
                : "SAVING…"
              : mode === "create"
                ? "CREATE LOGIN"
                : "SAVE CHANGES"}
          </button>
        </div>
      </motion.form>
    </motion.div>
  );
}
