/**
 * response: one model call's full output, blocks in provider order (thinking,
 * text, tool_use), logged before its tools run. tool_result: one tool's outcome,
 * with the tool name and audit fields. Messages live in `messages`, not the log.
 */
export type LogEvent = "response" | "tool_result";

/** One browser or terminal task in Nas that an agent owns or last steered. */
export type AgentSession = {
  /** The task's address, such as `task/browser/3`. */
  id: string;
  kind: "browser" | "terminal";
  status: "working" | "paused" | "idle" | "asking" | "asleep" | "stopped";
  purpose: string;
  /** The page a browser is on, or the directory and files a terminal has touched. */
  current: string;
  last_activity: string;
};

/** The helper tasks this agent owns or last steered (see runtime/sessions.ts). */
export type AgentSessions = {
  tasks: AgentSession[];
};

/** What an agent is waiting on, and since when (see runtime/watches.ts). */
export type AgentWaiting = {
  targets: string[];
  since: string;
  wakes_by: string;
};

/** One job's record, read from the rows stamped with its id (see runtime/ledger.ts). */
export type JobLedger = {
  /** The job's number (its opening message's seq). */
  job: number;
  /** Who asked: an agent id, or null for Ankur; the agent's own id for a routine run. */
  requester: string | null;
  /** The opening message, clipped, and when it was written. */
  opened: { seq: number; at: string; content: string };
  /** When the answer is due, for Ankur's jobs. */
  answer_by: string | null;
  /** Each agent this agent asked in the job, oldest first, with the seq of that agent's first message back (null while none). */
  asks: { to: string; seq: number; answered_seq: number | null }[];
  /** The helper tasks steered in the job. */
  helpers: string[];
  /** What was stored in memory in the job: the titles. */
  stored: string[];
  /** What this agent already sent the requester in the job, oldest first, clipped. */
  told: { seq: number; preview: string }[];
  /** The job's reminders, soonest first (ISO). */
  reminders: string[];
  /** When and by whom the job was stopped; null while it was not. */
  stopped: { at: string; by: string } | null;
};

export type AgentRecord = {
  id: string;
  name: string;
  system_prompt: string;
  /** The agent's directory entry (see runtime/directory.ts); null until it sets one. */
  description: string | null;
  parent_agent_id: string | null;
  active: boolean;
  /**
   * Whether the agent is running now (in memory: false right after a restart), what it is
   * waiting on, and the job its current wake is on (see runtime/ledger.ts; null when it has none).
   */
  running: { working: boolean; waiting_on: AgentWaiting | null; job: JobLedger | null };
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

/** One router run in flight, from the moment `POST /router` accepts it until it finishes or fails; `GET /router` lists these. */
export type RouterRun = {
  /** The id its `router_started`, `router_finished` and `router_failed` events carry. */
  run_id: string;
  /** ISO time the run started. */
  at: string;
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
  event: LogEvent;
  payload: Record<string, unknown>;
  /** The wake the row belongs to; null for the router, rows from before wake ids, and boot recovery's reports. */
  wake_id: string | null;
  created_at: string;
};

/** API shape for a routines row: an agent's own standing duty. */
export type RoutineRecord = {
  id: string;
  agent_id: string;
  title: string;
  procedure: string;
  /** Local time of day, HH:MM, in the box's zone. */
  at: string;
  /** Weekdays it runs on (mon..sun); null is every day. */
  days: Weekday[] | null;
  next_run_at: string;
  last_run_at: string | null;
  last_job_id: string | null;
  active: boolean;
  created_at: string;
};

/** API shape for a reminders row: a later step of a job. */
export type ReminderRecord = {
  id: string;
  agent_id: string;
  job_id: string | null;
  note: string;
  run_at: string;
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
  /** Which provider produced an assistant turn; Dwar replays its own
   * provider's turns verbatim and translates the other's. */
  provider?: DwarProvider;
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
 * What an agent's message to whoever gave it a job says about that job: the result, a wall,
 * or a question only the requester can answer. A progress line is not a status.
 */
export const MESSAGE_STATUSES = ["done", "blocked", "needs_input"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Where a job stands: open, waiting on the requester's answer, or closed one of four ways. */
export type JobState = "open" | "needs_input" | "done" | "blocked" | "noop" | "stopped";

/** The weekdays a routine runs on. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** What an agent_activity row records (see runtime/activity.ts). */
export const ACTIVITY_KINDS = ["site_read", "store", "recall_digest", "send", "routine", "reminder", "stop"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * A message someone wrote, hath's notice that an agent's work stopped (see deliver.ts), or
 * an utterance: what Ankur said to the router, which is no conversation's message.
 */
export type MessageKind = "message" | "notice" | "utterance";

/** Why a wake began (see `wakes` in db/schema.ts). */
export type WakeReasonKind = "message" | "schedule" | "recovery" | "steer" | "manual";

/**
 * The structured reason a wake is created with; `ref` is the sender agent id for `message`, the
 * routine or reminder id for `schedule`.
 */
export type WakeOrigin = {
  kind: WakeReasonKind;
  ref: string | null;
  /** The message that opened the wake, when one did. */
  openedByMessageId: string | null;
  /** The job the wake belongs to (see runtime/job-of.ts); absent when the reason is no job's. */
  jobId?: string;
  /** True when the wake's reason opened that job. */
  jobIsNew?: boolean;
};


/** A message as the wake routes return it: speech with its attachments (see `messages` in db/schema.ts). */
export type MessageRecord = {
  id: string;
  seq: number;
  kind: MessageKind;
  status: MessageStatus | null;
  from_agent_id: string | null;
  to_agent_id: string | null;
  content: string;
  created_at: string;
  attachments: AttachmentSummary[];
};

/** Where a wake stands, derived and never stored (see `wakeOutcome` in serialize.ts). */
export type WakeOutcome = "running" | "waiting" | "yielded" | "failed";

/** Model usage summed over a wake's `response` rows; `calls` is how many rows. */
export type WakeUsage = {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_write: number;
  cache_read: number;
};

/** One wake as `GET /agents/:id/wakes` lists it and `GET /agents/:id/wakes/:wake_id` opens it. */
export type WakeRecord = {
  id: string;
  agent_id: string;
  reason: { kind: WakeReasonKind; ref: string | null };
  opened_by: MessageRecord | null;
  started_at: string;
  ended_at: string | null;
  outcome: WakeOutcome;
  error: string | null;
  usage: WakeUsage;
  counts: { tool_calls: number; messages_sent: number; messages_received: number };
  /** True when the wake ended with no activity rows and the agent's oldest activity row is newer than it: the activity aged out. */
  activity_trimmed: boolean;
};

/** A tool call's outcome inside a wake; `content` is cut to the server cap when `truncated`, and `chars` is the full length. */
export type WakeToolResult = { content: string; is_error: boolean; truncated: boolean; chars: number };

/** One tool call of a turn, paired with its result by `tool_use_id`; `log_id` and `result` are null until the result is logged. */
export type WakeToolCall = {
  id: string;
  name: string;
  input: unknown;
  log_id: string | null;
  result: WakeToolResult | null;
};

/** One entry of a wake's timeline: a message the agent received or sent, or one model turn. */
export type WakeEntry =
  | { ord: number; at: string; type: "message"; direction: "sent" | "received"; message: MessageRecord }
  | {
      ord: number;
      at: string;
      type: "turn";
      usage: { input_tokens: number; output_tokens: number; cache_write: number; cache_read: number };
      thinking: string | null;
      text: string | null;
      calls: WakeToolCall[];
    };

/** The tool that sends a message: every agent's voice, and the router's. */
export const SEND_MESSAGE = "send_message";
export const FORWARD_ATTACHMENT = "forward_attachment";
export const YIELD = "yield";
export const READ_FILE = "read_file";
export const FIND_FILES = "find_files";
export const RECALL_MEMORY = "recall_memory";
export const INGEST_MEMORY = "ingest_memory";
export const LIST_AGENTS = "list_agents";
export const SPAWN_AGENT = "spawn_agent";
export const GET_DEVICE = "get_device";
export const CONTROL_DEVICE = "control_device";
export const MANAGE_AGENT = "manage_agent";
export const MODIFY_AGENT_PROMPT = "modify_agent_prompt";
export const GET_AGENT = "get_agent";

/** Token counts of one model call in a helper task's log. */
export type HelperLogUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/** A tool call a helper's model turn made. */
export type HelperLogCall = { id: string; name: string; input?: unknown };

/** One entry of a helper task's activity log in Nas: a steer, model turn, tool result, state change or report. */
export type HelperLogEntry = { seq: number; at: string; agent: string } & (
  | { type: "steer"; from: string; message: string; held: boolean; start: boolean }
  | { type: "turn"; ms: number; stop_reason: string; usage: HelperLogUsage; thinking: string; text: string; calls: HelperLogCall[] }
  | { type: "result"; tool_use_id: string; name: string; is_error: boolean; chars: number; head: string; ms: number }
  | { type: "state"; status: string; reason: string }
  | { type: "report"; state: string; text: string; files: string[] }
);

/** One page of a helper task's log; `next_seq` is the `after_seq` of the next page, null on the last. */
export type HelperTaskLog = { task: string; entries: HelperLogEntry[]; next_seq: number | null };
