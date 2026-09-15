import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { chaavi } from "../../shared/api";
import { useConnection } from "../../hooks/useConnection";
import { EASE, SLOW_S } from "../../shared/lib/ux/motion";
import { POLL_MS } from "../../shared/lib/ux/poll";

/**
 * Home Chaavi tile — login vs secret catalog counts. Notes count as secrets.
 * Never shows password bodies.
 */
export function ChaaviCounts() {
  const { state: connection } = useConnection();
  const connected = connection === "connected";

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

  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-ink-ghost">No vault yet</p>
      </div>
    );
  }

  if (healthQuery.isError) {
    return (
      <div className="flex h-full items-center justify-center px-3">
        <p className="text-center text-[13px] text-ink-muted">
          {healthQuery.error instanceof Error
            ? healthQuery.error.message
            : String(healthQuery.error)}
        </p>
      </div>
    );
  }

  if (healthQuery.isLoading || !healthQuery.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-ink-ghost">Loading…</p>
      </div>
    );
  }

  if (healthQuery.data.vault === "unconfigured") {
    return (
      <div className="flex h-full items-center justify-center px-3">
        <p className="text-center text-[13px] text-ink-ghost">Vault unconfigured</p>
      </div>
    );
  }

  if (itemsQuery.isError) {
    return (
      <div className="flex h-full items-center justify-center px-3">
        <p className="text-center text-[13px] text-ink-muted">
          {itemsQuery.error instanceof Error
            ? itemsQuery.error.message
            : String(itemsQuery.error)}
        </p>
      </div>
    );
  }

  if (itemsQuery.isLoading || !itemsQuery.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-ink-ghost">Loading…</p>
      </div>
    );
  }

  const items = itemsQuery.data.items;
  const passwords = items.filter((i) => i.kind === "login").length;
  const secrets = items.filter((i) => i.kind !== "login").length;

  return (
    <div className="flex h-full min-h-0 items-stretch px-2 pb-2.5 pt-0.5">
      {(
        [
          { label: "PASSWORDS", value: passwords },
          { label: "SECRETS", value: secrets },
        ] as const
      ).map((col, i) => (
        <motion.div
          key={col.label}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: SLOW_S, ease: EASE, delay: i * 0.04 }}
          className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-2 px-2 ${
            i > 0 ? "border-l border-rule/80" : ""
          }`}
        >
          <span className="text-[26px] font-medium leading-none tabular-nums tracking-tight text-ink">
            {col.value}
          </span>
          <span className="text-[10px] font-medium tracking-[1.2px] text-ink-ghost">
            {col.label}
          </span>
        </motion.div>
      ))}
    </div>
  );
}
