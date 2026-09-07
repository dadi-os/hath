import { useEffect, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { dimaag } from "../../api";
import type { AgentRecord, LogRecord } from "../../api/types";
import { useConnection } from "../../hooks/useConnection";
import { Popover } from "../../shared/Popover";
import { Tooltip } from "../../shared/Tooltip";
import { getRunning } from "../../store/running";
import {
  formatAbsolute,
  formatRelative,
  statusLabel,
  visualState,
} from "./tree";

function formatThought(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string" && b.text.trim()) {
        parts.push(b.text.trim());
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        parts.push(`[${b.name}]`);
      }
    }
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }
  return "thought";
}

function summarizeInput(input: unknown): string {
  if (input == null) {
    return "";
  }
  if (typeof input === "string") {
    return input.length > 96 ? `${input.slice(0, 96)}…` : input;
  }
  try {
    const s = JSON.stringify(input);
    return s.length > 96 ? `${s.slice(0, 96)}…` : s;
  } catch {
    return "";
  }
}

function formatLogLine(log: LogRecord): { text: string; error?: boolean } {
  if (log.event === "thought") {
    return { text: formatThought(log.payload) };
  }
  if (log.event === "tool_call") {
    const name =
      typeof log.payload.name === "string" ? log.payload.name : "tool";
    const input = summarizeInput(log.payload.input);
    return { text: input ? `${name} · ${input}` : name };
  }
  if (log.event === "tool_result") {
    const err = log.payload.is_error === true;
    const content =
      typeof log.payload.content === "string"
        ? log.payload.content
        : summarizeInput(log.payload.content);
    return {
      text: content ? `result · ${content}` : "result",
      error: err,
    };
  }
  const content =
    typeof log.payload.content === "string" ? log.payload.content : "message";
  return { text: content };
}

export type AgentPopoverProps = {
  open: boolean;
  agentId: string | null;
  agentsById: Map<string, AgentRecord>;
  runningMap: ReturnType<typeof getRunning>;
  anchor: { x: number; y: number } | null;
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSelectParent: (id: string) => void;
};

/**
 * Agent detail panel. Uses shared Popover for positioning / dismiss.
 * Last active is the newest log timestamp when available, else updated_at.
 */
export function AgentPopover({
  open,
  agentId,
  agentsById,
  runningMap,
  anchor,
  containerRef,
  onClose,
  onSelectParent,
}: AgentPopoverProps) {
  const { state: connection } = useConnection();
  const connected = connection === "connected";
  const [promptOpen, setPromptOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => {
      if (!agentId) {
        throw new Error("agentId required");
      }
      return dimaag.getAgent(agentId);
    },
    enabled: connected && !!agentId && open,
  });

  const logsQuery = useQuery({
    queryKey: ["agent-logs", agentId, "recent"],
    queryFn: async () => {
      if (!agentId) {
        throw new Error("agentId required");
      }
      const { logs } = await dimaag.getAgentLogs(agentId, { limit: 20 });
      return logs;
    },
    enabled: connected && !!agentId && open,
  });

  useEffect(() => {
    setPromptOpen(false);
  }, [agentId]);

  if (!agentId || !anchor) {
    return null;
  }

  const listAgent = agentsById.get(agentId);
  const detail = detailQuery.data;
  const running =
    runningMap[agentId] ??
    detail?.running ??
    listAgent?.running ?? { reasoning: false, conversation: false };
  const active = detail?.active ?? listAgent?.active ?? false;
  const name = detail?.name ?? listAgent?.name ?? "…";
  const createdAt = detail?.created_at ?? listAgent?.created_at;
  const updatedAt = detail?.updated_at ?? listAgent?.updated_at;
  const lastLogAt = logsQuery.data?.[0]?.created_at;
  const lastActiveAt = lastLogAt ?? updatedAt;
  const visual = visualState(
    {
      id: agentId,
      name,
      system_prompt: "",
      parent_agent_id: detail?.parent_agent_id ?? listAgent?.parent_agent_id ?? null,
      active,
      running,
      created_at: createdAt ?? new Date(0).toISOString(),
      updated_at: updatedAt ?? new Date(0).toISOString(),
    },
    running,
  );
  const status = statusLabel(visual, running);
  const parentId = detail?.parent_agent_id ?? listAgent?.parent_agent_id ?? null;
  const parent = parentId ? agentsById.get(parentId) : undefined;
  const childCount = detail?.children.length ?? 0;

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchor={anchor}
      containerRef={containerRef}
      aria-label={`${name} details`}
      className="max-h-[min(70%,520px)]"
    >
      <div className="shrink-0 border-b border-rule/60 px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-medium text-ink">{name}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] tracking-wide text-ink-faint hover:text-ink-muted"
          >
            ESC
          </button>
        </div>
        <p className="mt-1 text-[12px] text-ink-muted">{status}</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <section className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
          <span className="text-ink-ghost">Created</span>
          <Tooltip content={createdAt ? formatAbsolute(createdAt) : "—"}>
            <span className="text-ink-muted">
              {createdAt ? formatRelative(createdAt) : "—"}
            </span>
          </Tooltip>
          <span className="text-ink-ghost">Last active</span>
          <Tooltip
            content={
              lastActiveAt
                ? `${formatAbsolute(lastActiveAt)}${lastLogAt ? "" : " · row updated"}`
                : "—"
            }
          >
            <span className="text-ink-muted">
              {lastActiveAt ? formatRelative(lastActiveAt) : "—"}
            </span>
          </Tooltip>
          <span className="text-ink-ghost">Status</span>
          <span className="text-ink-muted">{status}</span>
        </section>

        {detailQuery.isError && (
          <p className="text-[13px] text-ink-muted">Could not load agent detail.</p>
        )}

        {detail && (
          <>
            <section className="mb-4">
              <h3 className="mb-1.5 text-[11px] font-medium tracking-[2px] text-ink-faint">
                SYSTEM PROMPT
              </h3>
              <p
                className={`whitespace-pre-wrap text-[13px] leading-relaxed text-ink ${
                  promptOpen ? "" : "line-clamp-4"
                }`}
              >
                {detail.system_prompt}
              </p>
              {detail.system_prompt.length > 160 && (
                <button
                  type="button"
                  className="mt-1 text-[12px] text-sage-deep"
                  onClick={() => setPromptOpen((v) => !v)}
                >
                  {promptOpen ? "Collapse" : "Expand"}
                </button>
              )}
            </section>

            <section className="mb-4">
              <h3 className="mb-1.5 text-[11px] font-medium tracking-[2px] text-ink-faint">
                TOOLS
              </h3>
              {detail.tools.length === 0 ? (
                <p className="text-[13px] text-ink-muted">No granted tools.</p>
              ) : (
                <ul className="space-y-2">
                  {detail.tools.map((t) => (
                    <li key={t.name}>
                      <div className="text-[13px] font-medium text-ink">{t.name}</div>
                      <div className="text-[12px] leading-snug text-ink-muted">
                        {t.usage}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mb-4">
              <h3 className="mb-1.5 text-[11px] font-medium tracking-[2px] text-ink-faint">
                RELATIONS
              </h3>
              <p className="text-[13px] text-ink-muted">
                Parent:{" "}
                {parent ? (
                  <button
                    type="button"
                    className="text-sage-deep"
                    onClick={() => onSelectParent(parent.id)}
                  >
                    {parent.name}
                  </button>
                ) : (
                  "—"
                )}
              </p>
              <p className="mt-0.5 text-[13px] text-ink-muted">
                Children: {childCount}
              </p>
            </section>

            <section className="mb-4">
              <h3 className="mb-1.5 text-[11px] font-medium tracking-[2px] text-ink-faint">
                BROWSER
              </h3>
              <p className="text-[12px] text-ink-ghost">
                No browser tools yet — session screens will show here.
              </p>
            </section>

            <section>
              <h3 className="mb-1.5 text-[11px] font-medium tracking-[2px] text-ink-faint">
                RECENT ACTIVITY
              </h3>
              {logsQuery.isError && (
                <p className="text-[13px] text-ink-muted">Could not load logs.</p>
              )}
              {logsQuery.data && logsQuery.data.length === 0 && (
                <p className="text-[13px] text-ink-muted">No recent logs.</p>
              )}
              {logsQuery.data && logsQuery.data.length > 0 && (
                <ul className="space-y-2">
                  {logsQuery.data.map((log) => {
                    const line = formatLogLine(log);
                    return (
                      <li key={log.id} className="text-[12px] leading-snug">
                        <span className="mr-1.5 text-[10px] tracking-wide text-ink-ghost">
                          {log.event}
                        </span>
                        <span
                          className={line.error ? "text-ink" : "text-ink-muted"}
                          style={
                            line.error
                              ? { color: "var(--sage-deep)" }
                              : undefined
                          }
                        >
                          {line.error ? "error · " : ""}
                          {line.text}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}

        {detailQuery.isLoading && (
          <p className="text-[13px] text-ink-muted">Loading…</p>
        )}
      </div>
    </Popover>
  );
}
