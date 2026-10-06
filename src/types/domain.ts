export type Lane = "reasoning" | "conversation" | "router";

/**
 * response: one model call's full output, blocks in provider order (thinking,
 * text, tool_use), logged before its tools run. tool_result: one tool's outcome,
 * with the tool name and audit fields. message: a delivered message.
 */
export type LogEvent = "response" | "tool_result" | "message";

/** Nas browsers/terminals this agent recently drove. Empty after process restart. */
export type AgentSessions = {
  browsers: number[];
  terminals: Array<{ id: string; last_command: string | null }>;
};

export type AgentRecord = {
  id: string;
  name: string;
  system_prompt: string;
  parent_agent_id: string | null;
  active: boolean;
  /** In-memory lane lock ownership. Always false right after a process restart. */
  running: { reasoning: boolean; conversation: boolean };
  /** In-memory host attachments. Always empty right after a process restart. */
  sessions: AgentSessions;
  created_at: string;
  updated_at: string;
};

/** One message the router sent as Ankur; `POST /router` returns these in order. */
export type RoutedMessage = {
  to_agent_id: string;
  content: string;
  seq: number;
  created_at: string;
};

export type LogRecord = {
  id: string;
  /** Null for the router. */
  agent_id: string | null;
  lane: Lane;
  event: LogEvent;
  payload: Record<string, unknown>;
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

export const SEND_MESSAGE = "send_message";
export const DISPATCH_MESSAGE = "dispatch_message";
export const STEER_REASONING = "steer_reasoning";
export const YIELD = "yield";
export const WAIT = "wait";
export const RECALL_MEMORY = "recall_memory";
export const INGEST_MEMORY = "ingest_memory";
export const LIST_AGENTS = "list_agents";
export const SPAWN_AGENT = "hath_spawn_agent";
export const MODIFY_AGENT = "modify_agent";
export const GET_AGENT = "get_agent";
