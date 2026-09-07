import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { dimaag } from "../../api";
import type { Lane, LogRecord } from "../../api/types";
import { formatAbsolute, formatRelative } from "./tree";
import { Tooltip } from "../../shared/Tooltip";

export type AgentActivityProps = {
  agentId: string;
  open: boolean;
  connected: boolean;
  /** Poll faster while a lane is running. */
  live?: boolean;
};

type ThoughtItem = {
  kind: "thought";
  key: string;
  lane: Lane;
  at: string;
  text: string | null;
  toolNames: string[];
};

type ToolItem = {
  kind: "tool";
  key: string;
  lane: Lane;
  at: string;
  name: string;
  input: Record<string, unknown>;
  resultContent: string | null;
  isError: boolean;
};

type ActivityItem = ThoughtItem | ToolItem;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractThought(payload: Record<string, unknown>): {
  text: string | null;
  toolNames: string[];
} {
  const content = payload.content;
  if (!Array.isArray(content)) {
    return { text: null, toolNames: [] };
  }
  const texts: string[] = [];
  const toolNames: string[] = [];
  for (const block of content) {
    const row = asRecord(block);
    if (!row) {
      continue;
    }
    if (row.type === "text" && typeof row.text === "string") {
      const t = row.text.trim();
      if (t) {
        texts.push(t);
      }
    }
    if (row.type === "tool_use" && typeof row.name === "string") {
      toolNames.push(row.name);
    }
  }
  return {
    text: texts.length > 0 ? texts.join("\n") : null,
    toolNames,
  };
}

/** Newest-first feed: pair tool_call with its result, keep thoughts with signal. */
function buildActivity(logs: LogRecord[]): ActivityItem[] {
  const chronological = [...logs].reverse();
  const results = new Map<
    string,
    { content: string; isError: boolean; at: string }
  >();
  for (const log of chronological) {
    if (log.event !== "tool_result") {
      continue;
    }
    const id = log.payload.tool_use_id;
    if (typeof id !== "string") {
      continue;
    }
    results.set(id, {
      content: typeof log.payload.content === "string" ? log.payload.content : "",
      isError: log.payload.is_error === true,
      at: log.created_at,
    });
  }

  const items: ActivityItem[] = [];
  for (const log of chronological) {
    if (log.event === "thought") {
      const { text, toolNames } = extractThought(log.payload);
      if (!text && toolNames.length === 0) {
        continue;
      }
      items.push({
        kind: "thought",
        key: log.id,
        lane: log.lane,
        at: log.created_at,
        text,
        toolNames,
      });
      continue;
    }
    if (log.event === "tool_call") {
      const id = typeof log.payload.id === "string" ? log.payload.id : log.id;
      const name =
        typeof log.payload.name === "string" ? log.payload.name : "tool";
      const input = asRecord(log.payload.input) ?? {};
      const result = results.get(id);
      items.push({
        kind: "tool",
        key: log.id,
        lane: log.lane,
        at: log.created_at,
        name,
        input,
        resultContent: result?.content ?? null,
        isError: result?.isError ?? false,
      });
    }
  }

  return items.reverse();
}

function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) {
    return one;
  }
  return `${one.slice(0, max - 1)}…`;
}

function prettyValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function LaneMark({ lane }: { lane: Lane }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-[1.5px] text-ink-ghost">
      {lane === "reasoning" ? "reason" : "talk"}
    </span>
  );
}

function ParamList({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input);
  if (entries.length === 0) {
    return (
      <p className="mt-1 text-[11px] italic text-ink-ghost">no parameters</p>
    );
  }
  return (
    <dl className="mt-1.5 space-y-1">
      {entries.map(([key, value]) => {
        const rendered = prettyValue(value);
        const multiline = rendered.includes("\n") || rendered.length > 72;
        return (
          <div key={key} className="min-w-0">
            <dt className="font-mono text-[10px] tracking-wide text-sage-deep">
              {key}
            </dt>
            <dd
              className={`mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-ink-muted ${
                multiline ? "max-h-24 overflow-y-auto" : ""
              }`}
            >
              {rendered}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function ThoughtRow({ item }: { item: ThoughtItem }) {
  const [open, setOpen] = useState(false);
  const preview = item.text ? truncate(item.text, 140) : null;
  const long = Boolean(item.text && item.text.length > 140);

  return (
    <li className="relative pl-4">
      <span
        aria-hidden
        className="absolute left-0 top-1.5 size-1.5 rounded-full bg-sage-line"
      />
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium tracking-[1.5px] text-ink-faint">
          THINKING
        </span>
        <div className="flex items-center gap-2">
          <LaneMark lane={item.lane} />
          <Tooltip content={formatAbsolute(item.at)}>
            <span className="text-[10px] text-ink-ghost">
              {formatRelative(item.at)}
            </span>
          </Tooltip>
        </div>
      </div>
      {preview ? (
        <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
          {open && item.text ? item.text : preview}
        </p>
      ) : (
        <p className="mt-1 text-[12px] italic text-ink-ghost">
          chose {item.toolNames.join(", ")}
        </p>
      )}
      {long && (
        <button
          type="button"
          className="mt-0.5 text-[11px] text-sage-deep"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Less" : "More"}
        </button>
      )}
    </li>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const [paramsOpen, setParamsOpen] = useState(item.name !== "yield");
  const hasParams = Object.keys(item.input).length > 0;
  const resultPreview =
    item.resultContent !== null
      ? truncate(item.resultContent, 160)
      : null;

  return (
    <li className="relative pl-4">
      <span
        aria-hidden
        className={`absolute left-0 top-1.5 size-1.5 rounded-full ${
          item.isError ? "bg-ink-muted" : "bg-sage"
        }`}
      />
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[12px] font-medium text-ink">
          {item.name}
        </span>
        <div className="flex items-center gap-2">
          <LaneMark lane={item.lane} />
          <Tooltip content={formatAbsolute(item.at)}>
            <span className="text-[10px] text-ink-ghost">
              {formatRelative(item.at)}
            </span>
          </Tooltip>
        </div>
      </div>

      {hasParams && (
        <button
          type="button"
          className="mt-1 text-[10px] font-medium tracking-[1.5px] text-ink-faint hover:text-sage-deep"
          onClick={() => setParamsOpen((v) => !v)}
        >
          {paramsOpen ? "PARAMS ▴" : "PARAMS ▾"}
        </button>
      )}
      {paramsOpen && hasParams ? <ParamList input={item.input} /> : null}

      {item.resultContent !== null && (
        <div
          className={`mt-1.5 border-l-2 pl-2 text-[11px] leading-snug ${
            item.isError
              ? "border-ink-faint text-ink-muted"
              : "border-sage-line text-ink-muted"
          }`}
        >
          <span className="mr-1.5 text-[10px] font-medium tracking-[1.5px] text-ink-ghost">
            {item.isError ? "ERROR" : "RESULT"}
          </span>
          {resultPreview}
        </div>
      )}
    </li>
  );
}

/**
 * Recent agent lane activity from durable logs — thinking, tool calls, results.
 * This is the log explorer slice for one agent, not the chat transcript.
 */
export function AgentActivity({
  agentId,
  open,
  connected,
  live = false,
}: AgentActivityProps) {
  const logsQuery = useQuery({
    queryKey: ["agent-logs", agentId, "activity"],
    queryFn: async () => {
      const { logs } = await dimaag.getAgentLogs(agentId, { limit: 48 });
      return logs;
    },
    enabled: connected && open,
    refetchInterval: live ? 2_000 : 8_000,
  });

  const items = useMemo(
    () => (logsQuery.data ? buildActivity(logsQuery.data) : []),
    [logsQuery.data],
  );

  return (
    <section>
      <h3 className="mb-2 text-[11px] font-medium tracking-[2px] text-ink-faint">
        ACTIVITY
      </h3>

      {logsQuery.isLoading && (
        <p className="text-[13px] text-ink-muted">Loading activity…</p>
      )}
      {logsQuery.isError && (
        <p className="text-[13px] text-ink-muted">Could not load activity.</p>
      )}
      {!logsQuery.isLoading && !logsQuery.isError && items.length === 0 && (
        <p className="text-[13px] text-ink-muted">No recent activity.</p>
      )}

      {items.length > 0 && (
        <ol className="relative space-y-3.5 before:absolute before:bottom-1 before:left-[2px] before:top-1 before:w-px before:bg-rule">
          {items.map((item) =>
            item.kind === "thought" ? (
              <ThoughtRow key={item.key} item={item} />
            ) : (
              <ToolRow key={item.key} item={item} />
            ),
          )}
        </ol>
      )}
    </section>
  );
}
