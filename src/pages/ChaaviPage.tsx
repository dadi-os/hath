import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { PageHeader } from "../chrome/PageHeader";
import { useConnection } from "../hooks/useConnection";
import { CHAAVI, chaavi } from "../shared/api";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";
import { POLL_MS } from "../shared/lib/ux/poll";

/**
 * Chaavi catalog: vault item metadata and Bitwarden extension URL.
 * Not a password manager — fill happens in the extension at {@link CHAAVI}.
 */
export function ChaaviPage() {
  const { state } = useConnection();
  const connected = state === "connected";

  const healthQuery = useQuery({
    queryKey: ["chaavi", "health"],
    queryFn: () => chaavi.getHealth(),
    enabled: connected,
    refetchInterval: POLL_MS,
  });

  const itemsQuery = useQuery({
    queryKey: ["chaavi", "items"],
    queryFn: () => chaavi.listItems(),
    enabled: connected && healthQuery.data?.vault === "ready",
    refetchInterval: POLL_MS,
  });

  const items = itemsQuery.isSuccess ? itemsQuery.data.items : undefined;

  return (
    <motion.div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <PageHeader
        title="CHAAVI"
        hint={`Catalog only — fill passwords in the Bitwarden extension at ${CHAAVI}.`}
      />

      <div className="min-h-0 flex-1 px-1 pb-1">
        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius)] border border-dashed border-sage-line bg-bone/40 px-3 py-3">
          <div className="mb-3 shrink-0 border-b border-dashed border-sage-line pb-3">
            <span className="mb-2 block text-[11px] font-medium tracking-[2px] text-sage-deep">
              VAULT
            </span>
            {!connected ? (
              <p className="text-[13px] text-ink-ghost">Connect to load vault</p>
            ) : healthQuery.isError ? (
              <p className="text-[13px] text-ink-muted">
                {healthQuery.error instanceof Error
                  ? healthQuery.error.message
                  : String(healthQuery.error)}
              </p>
            ) : healthQuery.isLoading || !healthQuery.data ? (
              <p className="text-[13px] text-ink-ghost">Loading…</p>
            ) : (
              <p className="text-[13px] text-ink">
                {healthQuery.data.vault === "ready"
                  ? "Ready"
                  : "Unconfigured"}
              </p>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-ink-ghost">
              Point the Bitwarden browser extension at{" "}
              <span className="text-ink-muted">{CHAAVI}</span>. Hath never shows
              or copies passwords.
            </p>
          </div>

          <span className="mb-3 shrink-0 text-[11px] font-medium tracking-[2px] text-sage-deep">
            ITEMS
          </span>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!connected ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-[13px] text-ink-ghost">
                  Connect to load vault items
                </p>
              </div>
            ) : healthQuery.isError ? (
              <div className="flex h-full items-center justify-center px-4">
                <p className="text-center text-[13px] text-ink-muted">
                  {healthQuery.error instanceof Error
                    ? healthQuery.error.message
                    : String(healthQuery.error)}
                </p>
              </div>
            ) : healthQuery.data?.vault === "unconfigured" ? (
              <div className="flex h-full items-center justify-center px-4">
                <p className="text-center text-[13px] text-ink-ghost">
                  Vault unconfigured — sign up in the Bitwarden extension, then
                  set BW_* and restart chaavi.
                </p>
              </div>
            ) : itemsQuery.isError ? (
              <div className="flex h-full items-center justify-center px-4">
                <p className="text-center text-[13px] text-ink-muted">
                  {itemsQuery.error instanceof Error
                    ? itemsQuery.error.message
                    : String(itemsQuery.error)}
                </p>
              </div>
            ) : itemsQuery.isLoading || items === undefined ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-[13px] text-ink-ghost">Loading…</p>
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-[13px] text-ink-ghost">No vault items</p>
              </div>
            ) : (
              <ul className="divide-y divide-sage-line/70">
                {items.map((item) => (
                  <li key={item.id} className="flex flex-col gap-1 px-1 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 text-[13px] text-ink">
                        {item.name}
                      </span>
                      <span className="shrink-0 text-[10px] font-medium tracking-[2px] text-sage-deep">
                        {item.kind.toUpperCase()}
                      </span>
                    </div>
                    {item.username ? (
                      <p className="text-[11px] text-ink-muted">
                        {item.username}
                      </p>
                    ) : null}
                    {item.uris.length > 0 ? (
                      <p className="text-[11px] text-ink-ghost">
                        {item.uris.join(" · ")}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </motion.div>
  );
}
