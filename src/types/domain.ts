export type Lane = "work" | "process" | "router";

/**
 * response: one model call's full output, blocks in provider order (thinking,
 * text, tool_use), logged before its tools run. tool_result: one tool's outcome,
 * with the tool name and audit fields. message: a delivered message.
 */
export type LogEvent = "response" | "tool_result" | "message";

/** One browser or terminal task in Nas that an agent owns or last steered. */
export type AgentSession = {
  /** The task's address, such as `task/browser/3`. */
  id: string;
  kind: "browser" | "terminal";
  status: "working" | "idle" | "asking" | "asleep";
  purpose: string;
  /** The page a browser is on, or the directory and files a terminal has touched. */
  current: string;
  last_activity: string;
};

/** The helper tasks this agent owns or last steered (see runtime/sessions.ts). */
export type AgentSessions = {
  tasks: AgentSession[];
};

/** What an agent's work lane is waiting on, and since when (see runtime/watches.ts). */
export type AgentWaiting = {
  targets: string[];
  since: string;
  wakes_by: string;
};

/**
 * Where an agent's work stands, rendered by hath without a model call (see runtime/status.ts):
 * the process lane's last turn, and the UI's popover.
 */
export type AgentStatus = {
  /** The latest message from whoever gave the agent its job; null when none has. */
  job: { from: string | null; at: string; content: string } | null;
  work: {
    state: "running" | "waiting" | "idle";
    /** When it began waiting, or its last step while running; null while idle. */
    since: string | null;
    /** What it waits on, when waiting. */
    waiting_on: string[];
  };
  /** The work lane's current step: its last tool call, with a short argument; null before it has acted. */
  step: string | null;
  /** The work lane's last five tool calls, oldest first; `ok` is null while a call has no result. */
  recent: { name: string; arg: string; ok: boolean | null }[];
  /** The Nas tasks the agent owns that are in flight. */
  tasks: { id: string; status: string; current: string }[];
  /** Why the tasks could not be read from Nas, or null. */
  tasks_unreadable: string | null;
  /** Messages the work lane queued that the process lane has not sent. */
  pending: { id: number; to: string | null; expects_reply: boolean; preview: string }[];
};

export type AgentRecord = {
  id: string;
  name: string;
  system_prompt: string;
  /** The agent's directory entry (see runtime/directory.ts); null until it sets one. */
  description: string | null;
  parent_agent_id: string | null;
  active: boolean;
  /** In-memory lane lock ownership (always false right after a process restart), and what the work lane is waiting on. */
  running: { work: boolean; process: boolean; waiting_on: AgentWaiting | null; status: AgentStatus | null };
  /** The browser and terminal tasks the agent has in Nas. */
  sessions: AgentSessions;
  created_at: string;
  updated_at: string;
};

/** One message the router sent as Ankur; `POST /router` returns these in order. */
export type RoutedMessage = {
  to_agent_id: string;
  content: string;
  attachments: AttachmentSummary[];
  seq: number;
  created_at: string;
};

/** Attachment metadata on HTTP responses and runtime events; bytes come from GET /attachments/:id. */
export type AttachmentSummary = {
  id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  /** image.describe text for images, null otherwise. */
  description: string | null;
};

export type LogRecord = {
  id: string;
  /** Null for the router. */
  agent_id: string | null;
  lane: Lane;
  event: LogEvent;
  payload: Record<string, unknown>;
  /** The wake the row belongs to; null for the router, rows from before wake ids, and boot recovery's reports. */
  wake_id: string | null;
  created_at: string;
};

/** API shape for a scheduled_messages row. Presence of the row is the state. */
export type ScheduledMessageRecord = {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  content: string;
  /** Next fire time (ISO). Ticker cursor — advanced after each fire. */
  run_at: string;
  /** null = one-shot; >= 1 = recurring interval in minutes. */
  interval_minutes: number | null;
  created_at: string;
};

export type DwarProvider = "anthropic" | "gemini";

export type DwarTextBlock = {
  type: "text";
  text: string;
  /** Opaque provider state (Gemini signs a trailing text part). Round-trip unchanged. */
  thought_signature?: string | null | undefined;
};

/** Model thinking: Anthropic thinking, or a Gemini thought summary. */
export type DwarThinkingBlock = {
  type: "thinking";
  thinking: string;
  /** Opaque provider signature. Round-trip unchanged. */
  signature?: string | null | undefined;
};

/** Anthropic thinking the provider encrypted. Round-trip unchanged. */
export type DwarRedactedThinkingBlock = {
  type: "redacted_thinking";
  data: string;
};

export type DwarToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  /** Opaque provider state (Gemini thought signatures). Round-trip unchanged. */
  thought_signature?: string | null | undefined;
};

export type DwarToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
};

export type DwarResponseBlock =
  | DwarTextBlock
  | DwarThinkingBlock
  | DwarRedactedThinkingBlock
  | DwarToolUseBlock;

export type DwarContentBlock = DwarResponseBlock | DwarToolResultBlock;

export type DwarMessage = {
  role: "user" | "assistant";
  content: string | DwarContentBlock[];
  /** Which provider and lane produced an assistant turn; Dwar replays its own
   * provider's turns verbatim and translates the other's. */
  provider?: DwarProvider;
  lane?: Lane;
  /** Ends a prefix resent unchanged into the next wake (the frozen transcript);
   * Dwar keeps a long-lived provider cache entry there. At most one per request. */
  cache_breakpoint?: boolean;
};

export type DwarTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type DwarChatRequest = {
  system: string;
  messages: DwarMessage[];
  tools: DwarTool[];
  /** auto lets the model think and write around tool calls; any forces a call every turn. */
  tool_choice: "auto" | "any";
};

export type DwarChatResponse = {
  provider: DwarProvider;
  content: DwarResponseBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "error";
  usage: DwarUsage;
};

/** Token accounting Dwar returns per call; cache fields make prompt-cache hits visible in agent_logs. */
export type DwarUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/**
 * What an agent's message to whoever gave it a job says about that job: its one
 * progress update, a question only the requester can answer, a wall, or the result.
 */
export const MESSAGE_STATUSES = ["running", "needs_input", "blocked", "done"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Where a job stands: open, waiting on the requester's answer, or closed one of three ways. */
export type JobState = "open" | "needs_input" | "done" | "blocked" | "noop";

/** A message someone wrote, or hath's notice that an agent's work stopped (see deliver.ts). */
export type MessageKind = "message" | "notice";


/** Where an outbox row stands: waiting for the process lane, sent, declined (rows from before the lane overhaul), or lost with its lane. */
export type HandoffState = "pending" | "sent" | "declined" | "failed";

/** The router's own send tools; agents' are SEND and MESSAGE. */
export const SEND_MESSAGE = "send_message";
export const FORWARD_ATTACHMENT = "forward_attachment";
/** The process lane's voice: messages Ankur or an agent. */
export const SEND = "send";
/** The work lane's way to give its process lane something to say. */
export const MESSAGE = "message";
export const STEER_WORK = "steer_work";
export const YIELD = "yield";
export const WAIT = "wait";
export const READ_FILE = "read_file";
export const FIND = "find";
export const RECALL_MEMORY = "recall_memory";
export const INGEST_MEMORY = "ingest_memory";
export const LIST_AGENTS = "list_agents";
export const SPAWN_AGENT = "hath_spawn_agent";
export const MANAGE_AGENT = "manage_agent";
export const MODIFY_AGENT_PROMPT = "modify_agent_prompt";
export const GET_AGENT = "get_agent";
