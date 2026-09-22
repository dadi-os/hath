import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useConnection } from "../../hooks/useConnection";
import { CHAAVI_VAULT, chaavi, isMeshOnline } from "../../shared/api";
import type {
  ChaaviCreateLogin,
  ChaaviItem,
  ChaaviUpdateLogin,
} from "../../shared/api/types";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";
import { POLL_MS } from "../../shared/lib/ux/poll";
import { copyText } from "./copy";
import { LoginEditor } from "./editor";

const ITEMS_KEY = ["chaavi", "items"] as const;
const HEALTH_KEY = ["chaavi", "health"] as const;
const FAST = 0.18;

type EditorMode =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; item: ChaaviItem };

/**
 * Vault login manager: search, reveal/copy, create, edit, delete.
 * Secrets live in component state only — never in the React Query cache.
 */
export function PasswordManager() {
  const queryClient = useQueryClient();
  const { state } = useConnection();
  const connected = isMeshOnline(state);

  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorMode>({ kind: "closed" });
  const [revealed, setRevealed] = useState<{
    id: string;
    username: string;
    password: string;
  } | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [copiedField, setCopiedField] = useState<"username" | "password" | null>(
    null,
  );
  const [busyError, setBusyError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const healthQuery = useQuery({
    queryKey: HEALTH_KEY,
    queryFn: () => chaavi.getHealth(),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const itemsQuery = useQuery({
    queryKey: ITEMS_KEY,
    queryFn: () => chaavi.listItems(),
    enabled: connected && healthQuery.data?.vault === "ready",
    refetchInterval: POLL_MS,
  });

  const items = itemsQuery.isSuccess ? itemsQuery.data.items : [];
  const filtered = useMemo(() => filterItems(items, query), [items, query]);
  const selected =
    selectedId === null
      ? null
      : (items.find((item) => item.id === selectedId) ?? null);

  const clearReveal = useEffectEvent(() => {
    setRevealed(null);
    setPasswordVisible(false);
    setCopiedField(null);
    setConfirmDelete(false);
    setBusyError(null);
  });

  useEffect(() => {
    clearReveal();
  }, [selectedId]);

  useEffect(() => {
    return () => {
      clearReveal();
    };
  }, []);

  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) {
      setSelectedId(null);
    }
  }, [items, selectedId]);

  const invalidateItems = () =>
    queryClient.invalidateQueries({ queryKey: ITEMS_KEY });

  const revealMutation = useMutation({
    mutationFn: (id: string) => chaavi.revealLogin(id),
    onSuccess: (cred, id) => {
      setRevealed({ id, username: cred.username, password: cred.password });
      setPasswordVisible(true);
      setBusyError(null);
    },
    onError: (err) => {
      setBusyError(err instanceof Error ? err.message : String(err));
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (
      payload:
        | { mode: "create"; body: ChaaviCreateLogin }
        | { mode: "edit"; id: string; body: ChaaviUpdateLogin },
    ) => {
      if (payload.mode === "create") {
        return chaavi.createLogin(payload.body);
      }
      return chaavi.updateLogin(payload.id, payload.body);
    },
    onSuccess: async (item) => {
      await invalidateItems();
      setEditor({ kind: "closed" });
      setSelectedId(item.id);
      clearReveal();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => chaavi.deleteItem(id),
    onSuccess: async () => {
      await invalidateItems();
      setSelectedId(null);
      clearReveal();
    },
    onError: (err) => {
      setBusyError(err instanceof Error ? err.message : String(err));
    },
  });

  const onCopy = async (field: "username" | "password", value: string) => {
    try {
      await copyText(value);
      setBusyError(null);
      setCopiedField(field);
      window.setTimeout(() => {
        setCopiedField((current) => (current === field ? null : current));
      }, 1400);
    } catch (err) {
      setBusyError(err instanceof Error ? err.message : String(err));
    }
  };

  const vaultReady = healthQuery.data?.vault === "ready";

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 gap-3">
        <aside className="widget-frame flex w-[min(100%,20rem)] shrink-0 flex-col">
          <div className="widget-frame__chrome !justify-between gap-2 !px-3 !pb-2 !pt-3">
            <span className="widget-frame__title">Vault</span>
            <button
              type="button"
              disabled={!connected || !vaultReady}
              onClick={() => {
                setBusyError(null);
                setEditor({ kind: "create" });
              }}
              className="rounded-[7px] border border-dashed border-sage-line bg-[var(--glass-sheet)] px-2.5 py-1 text-[10px] font-medium tracking-[1.6px] text-sage-deep transition-[border-color,background-color] duration-slow ease-hath hover:border-sage hover:bg-sage-active/50 disabled:cursor-default disabled:opacity-40"
            >
              NEW
            </button>
          </div>
          <div className="widget-frame__body flex flex-col px-3 pb-3">
            <label className="mb-2 block shrink-0">
              <span className="sr-only">Search vault</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, user, site…"
                disabled={!vaultReady}
                className="w-full rounded-[var(--radius)] border border-rule bg-bone/50 px-3 py-2 text-[13px] text-ink outline-none transition-[border-color] duration-slow ease-hath placeholder:text-ink-ghost focus:border-sage disabled:opacity-50"
              />
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <VaultListBody
                connected={connected}
                health={healthQuery}
                itemsQuery={itemsQuery}
                items={filtered}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </div>
          </div>
        </aside>

        <section className="widget-frame min-w-0 flex-1">
          <div className="widget-frame__chrome !justify-start !px-4 !pb-2 !pt-3">
            <span className="widget-frame__title">
              {selected ? selected.kind.toUpperCase() : "Detail"}
            </span>
          </div>
          <div className="widget-frame__body overflow-y-auto px-4 pb-4">
            <AnimatePresence mode="wait">
              {selected ? (
                <motion.div
                  key={selected.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: SLOW_S, ease: EASE }}
                >
                  <ItemDetail
                    item={selected}
                    revealed={
                      revealed?.id === selected.id ? revealed : null
                    }
                    passwordVisible={passwordVisible}
                    copiedField={copiedField}
                    revealing={revealMutation.isPending}
                    deleting={deleteMutation.isPending}
                    confirmDelete={confirmDelete}
                    error={busyError}
                    onReveal={() => {
                      setBusyError(null);
                      revealMutation.mutate(selected.id);
                    }}
                    onShow={() => setPasswordVisible(true)}
                    onHide={() => {
                      setPasswordVisible(false);
                    }}
                    onCopyUsername={(value) => {
                      void onCopy("username", value);
                    }}
                    onCopyPassword={(value) => {
                      void onCopy("password", value);
                    }}
                    onEdit={() => {
                      setBusyError(null);
                      setEditor({ kind: "edit", item: selected });
                    }}
                    onAskDelete={() => setConfirmDelete(true)}
                    onCancelDelete={() => setConfirmDelete(false)}
                    onConfirmDelete={() => {
                      deleteMutation.mutate(selected.id);
                    }}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="empty-detail"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: FAST, ease: EASE }}
                  className="flex h-full min-h-[16rem] flex-col items-center justify-center gap-2 px-6 text-center"
                >
                  <p className="text-[15px] text-ink">Select a login</p>
                  <p className="max-w-sm text-[12px] leading-relaxed text-ink-ghost">
                    Search the vault, reveal a password when you need it, or
                    create a new login.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>
      </div>

      <footer className="mt-3 flex shrink-0 items-center justify-between gap-3 px-1">
        <p className="text-[11px] text-ink-ghost">
          Vaultwarden store · Chaavi adapter
        </p>
        <a
          href={CHAAVI_VAULT}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] font-medium tracking-[1.4px] text-sage-deep transition-colors duration-slow ease-hath hover:text-sage"
        >
          OPEN VAULT
        </a>
      </footer>

      <AnimatePresence>
        {editor.kind !== "closed" ? (
          <LoginEditor
            key={editor.kind === "edit" ? editor.item.id : "create"}
            mode={editor.kind}
            initial={
              editor.kind === "edit"
                ? {
                    name: editor.item.name,
                    username: editor.item.username ?? "",
                    uri: editor.item.uris[0] ?? "",
                  }
                : undefined
            }
            pending={saveMutation.isPending}
            error={
              saveMutation.isError
                ? saveMutation.error instanceof Error
                  ? saveMutation.error.message
                  : String(saveMutation.error)
                : null
            }
            onClose={() => {
              if (!saveMutation.isPending) {
                setEditor({ kind: "closed" });
                saveMutation.reset();
              }
            }}
            onSubmit={(values) => {
              setBusyError(null);
              if (editor.kind === "create") {
                const body: ChaaviCreateLogin = {
                  name: values.name,
                  username: values.username,
                };
                if (values.uri) {
                  body.uri = values.uri;
                }
                if (values.password) {
                  body.password = values.password;
                }
                saveMutation.mutate({ mode: "create", body });
                return;
              }
              if (editor.kind !== "edit") {
                return;
              }
              const body: ChaaviUpdateLogin = {};
              if (values.name !== editor.item.name) {
                body.name = values.name;
              }
              if (values.username !== (editor.item.username ?? "")) {
                body.username = values.username;
              }
              const prevUri = editor.item.uris[0] ?? "";
              if (values.uri !== prevUri) {
                body.uri = values.uri;
              }
              if (values.password) {
                body.password = values.password;
              }
              if (
                body.name === undefined &&
                body.username === undefined &&
                body.uri === undefined &&
                body.password === undefined
              ) {
                setEditor({ kind: "closed" });
                return;
              }
              saveMutation.mutate({
                mode: "edit",
                id: editor.item.id,
                body,
              });
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function filterItems(items: ChaaviItem[], raw: string): ChaaviItem[] {
  const q = raw.trim().toLowerCase();
  if (!q) {
    return items;
  }
  return items.filter((item) => {
    if (item.name.toLowerCase().includes(q)) {
      return true;
    }
    if (item.username?.toLowerCase().includes(q)) {
      return true;
    }
    return item.uris.some((uri) => uri.toLowerCase().includes(q));
  });
}

function VaultListBody(props: {
  connected: boolean;
  health: {
    isError: boolean;
    isLoading: boolean;
    data?: { vault: "ready" | "unconfigured" };
    error: unknown;
  };
  itemsQuery: {
    isError: boolean;
    isLoading: boolean;
    error: unknown;
  };
  items: ChaaviItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { connected, health, itemsQuery, items, selectedId, onSelect } = props;

  if (!connected) {
    return <ListMessage>Connect to load the vault</ListMessage>;
  }
  if (health.isError) {
    return (
      <ListMessage tone="error">
        {health.error instanceof Error
          ? health.error.message
          : String(health.error)}
      </ListMessage>
    );
  }
  if (health.isLoading || !health.data) {
    return <ListMessage>Loading…</ListMessage>;
  }
  if (health.data.vault === "unconfigured") {
    return (
      <ListMessage>
        Vault unconfigured — sign up at the Bitwarden vault, set BW_* in
        Preferences, restart Chaavi.
      </ListMessage>
    );
  }
  if (itemsQuery.isError) {
    return (
      <ListMessage tone="error">
        {itemsQuery.error instanceof Error
          ? itemsQuery.error.message
          : String(itemsQuery.error)}
      </ListMessage>
    );
  }
  if (itemsQuery.isLoading) {
    return <ListMessage>Loading…</ListMessage>;
  }
  if (items.length === 0) {
    return <ListMessage>No matching items</ListMessage>;
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item, i) => {
        const active = item.id === selectedId;
        return (
          <motion.li
            key={item.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: FAST,
              ease: EASE,
              delay: Math.min(i, 12) * 0.015,
            }}
          >
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              className={`flex w-full flex-col gap-0.5 rounded-[var(--radius)] px-2.5 py-2.5 text-left transition-[background-color,box-shadow] duration-fast ease-hath ${
                active
                  ? "bg-sage-active/70 shadow-[var(--shadow)]"
                  : "hover:bg-sage-faint"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-[13px] text-ink">
                  {item.name}
                </span>
                <span className="shrink-0 text-[9px] font-medium tracking-[1.6px] text-sage-deep">
                  {item.hasPasskey ? "PASSKEY" : item.kind.toUpperCase()}
                </span>
              </div>
              {item.username ? (
                <span className="truncate text-[11px] text-ink-muted">
                  {item.username}
                </span>
              ) : null}
              {item.uris[0] ? (
                <span className="truncate text-[11px] text-ink-ghost">
                  {item.uris[0]}
                </span>
              ) : null}
            </button>
          </motion.li>
        );
      })}
    </ul>
  );
}

function ListMessage(props: { children: ReactNode; tone?: "muted" | "error" }) {
  return (
    <div className="flex h-full min-h-[10rem] items-center justify-center px-3">
      <p
        className={`text-center text-[12px] leading-relaxed ${
          props.tone === "error" ? "text-ink-muted" : "text-ink-ghost"
        }`}
      >
        {props.children}
      </p>
    </div>
  );
}

function ItemDetail(props: {
  item: ChaaviItem;
  revealed: { username: string; password: string } | null;
  passwordVisible: boolean;
  copiedField: "username" | "password" | null;
  revealing: boolean;
  deleting: boolean;
  confirmDelete: boolean;
  error: string | null;
  onReveal: () => void;
  onShow: () => void;
  onHide: () => void;
  onCopyUsername: (value: string) => void;
  onCopyPassword: (value: string) => void;
  onEdit: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const {
    item,
    revealed,
    passwordVisible,
    copiedField,
    revealing,
    deleting,
    confirmDelete,
    error,
    onReveal,
    onShow,
    onHide,
    onCopyUsername,
    onCopyPassword,
    onEdit,
    onAskDelete,
    onCancelDelete,
    onConfirmDelete,
  } = props;

  const isLogin = item.kind === "login";
  const username = revealed?.username ?? item.username ?? "";
  const passwordDisplay = !revealed
    ? "••••••••••••"
    : passwordVisible
      ? revealed.password
      : "•".repeat(Math.min(18, Math.max(8, revealed.password.length)));

  let passwordAction = "REVEAL";
  if (revealing) {
    passwordAction = "…";
  } else if (revealed) {
    passwordAction = passwordVisible ? "HIDE" : "SHOW";
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-[22px] font-medium tracking-tight text-ink">
          {item.name}
        </h2>
        {item.uris[0] ? (
          <a
            href={item.uris[0]}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block truncate text-[13px] text-sage-deep hover:text-sage"
          >
            {item.uris[0]}
          </a>
        ) : (
          <p className="mt-1 text-[13px] text-ink-ghost">No website</p>
        )}
      </div>

      {isLogin ? (
        <div className="flex flex-col gap-3">
          <FieldRow
            label="USERNAME"
            value={username || "—"}
            actionLabel={copiedField === "username" ? "COPIED" : "COPY"}
            actionDisabled={!username}
            onAction={() => {
              if (username) {
                onCopyUsername(username);
              }
            }}
          />
          <FieldRow
            label="PASSWORD"
            value={passwordDisplay}
            mono
            actionLabel={passwordAction}
            onAction={() => {
              if (!revealed) {
                onReveal();
                return;
              }
              if (passwordVisible) {
                onHide();
                return;
              }
              onShow();
            }}
            secondaryLabel={
              revealed && passwordVisible
                ? copiedField === "password"
                  ? "COPIED"
                  : "COPY"
                : undefined
            }
            onSecondary={
              revealed && passwordVisible
                ? () => onCopyPassword(revealed.password)
                : undefined
            }
          />
        </div>
      ) : (
        <p className="text-[13px] leading-relaxed text-ink-muted">
          This {item.kind} is listed for agents and the Bitwarden vault. Login
          create/edit/delete in Hath covers passwords only.
        </p>
      )}

      {error ? (
        <p className="text-[12px] text-[var(--error)]">{error}</p>
      ) : null}

      {isLogin ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-rule/80 pt-4">
          <ActionButton onClick={onEdit}>EDIT</ActionButton>
          {confirmDelete ? (
            <>
              <ActionButton
                danger
                disabled={deleting}
                onClick={onConfirmDelete}
              >
                {deleting ? "DELETING…" : "CONFIRM DELETE"}
              </ActionButton>
              <ActionButton onClick={onCancelDelete}>CANCEL</ActionButton>
            </>
          ) : (
            <ActionButton danger onClick={onAskDelete}>
              DELETE
            </ActionButton>
          )}
        </div>
      ) : null}
    </div>
  );
}

function FieldRow(props: {
  label: string;
  value: string;
  mono?: boolean;
  actionLabel: string;
  actionDisabled?: boolean;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <div className="rounded-[var(--radius)] border border-dashed border-sage-line/80 bg-bone/30 px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium tracking-[2px] text-sage-deep">
          {props.label}
        </span>
        <div className="flex items-center gap-2">
          {props.secondaryLabel && props.onSecondary ? (
            <button
              type="button"
              onClick={props.onSecondary}
              className="text-[10px] font-medium tracking-[1.6px] text-sage-deep hover:text-sage"
            >
              {props.secondaryLabel}
            </button>
          ) : null}
          <button
            type="button"
            disabled={props.actionDisabled}
            onClick={props.onAction}
            className="text-[10px] font-medium tracking-[1.6px] text-sage-deep hover:text-sage disabled:opacity-40"
          >
            {props.actionLabel}
          </button>
        </div>
      </div>
      <p
        className={`break-all text-[14px] text-ink ${
          props.mono ? "font-mono tracking-wide" : ""
        }`}
      >
        {props.value}
      </p>
    </div>
  );
}

function ActionButton(props: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={`rounded-[7px] border border-dashed px-3 py-1.5 text-[10px] font-medium tracking-[1.8px] transition-[border-color,background-color,opacity] duration-slow ease-hath disabled:opacity-40 ${
        props.danger
          ? "border-error-line bg-error-fill/40 text-[var(--error)] hover:border-[var(--error)]"
          : "border-sage-line bg-[var(--glass-sheet)] text-sage-deep hover:border-sage hover:bg-sage-active/50"
      }`}
    >
      {props.children}
    </button>
  );
}
