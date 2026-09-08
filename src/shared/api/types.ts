/** Reasoning vs conversation lane on an agent. */
export type Lane = "reasoning" | "conversation";

/** Agent log event kinds from Dimaag. */
export type LogEvent = "thought" | "tool_call" | "tool_result" | "message";

/** Outbound file on POST /messages — base64 payload, no data-URL prefix. */
export type MessageAttachment = {
  media_type: string;
  data: string;
  filename?: string;
};

/** Response from Dimaag POST /messages. */
export type PostMessageResponse = {
  to_agent_id: string;
  content: string;
  seq: number;
  created_at: string;
};

/** Flat agent row from GET /agents. */
export type AgentRecord = {
  id: string;
  name: string;
  system_prompt: string;
  parent_agent_id: string | null;
  active: boolean;
  running: { reasoning: boolean; conversation: boolean };
  created_at: string;
  updated_at: string;
};

/** Agent detail including children and tool descriptors. */
export type AgentDetail = AgentRecord & {
  children: AgentRecord[];
  tools: Array<{ name: string; description: string; usage: string }>;
};

/** One agent log row from Dimaag. */
export type LogRecord = {
  id: string;
  agent_id: string;
  lane: Lane;
  event: LogEvent;
  payload: Record<string, unknown>;
  created_at: string;
};

/** Dimaag SSE event envelope. */
export type DimaagEvent =
  | {
      type: "message";
      agent_id: string;
      from_agent_id: string | null;
      to_agent_id: string | null;
      content: string;
      seq: number;
      at: string;
    }
  | { type: "lane_started"; agent_id: string; lane: Lane; at: string }
  | { type: "lane_finished"; agent_id: string; lane: Lane; at: string }
  | {
      type: "agent_spawned";
      agent_id: string;
      parent_agent_id: string;
      name: string;
      at: string;
    }
  | { type: "agent_modified"; agent_id: string; active: boolean; at: string };

/** Yaad node kind. */
export type NodeKind = "person" | "memory" | "plan" | "place";
/** Provenance of a Yaad write. */
export type NodeSource = "manual" | "agent" | "ingest";
/** Plan lifecycle status. */
export type PlanStatus = "idea" | "tentative" | "confirmed";

/** Person-kind detail payload. */
export type PersonDetail = {
  birthday: string | null;
  aliases: string[];
};

/** Plan-kind detail payload. */
export type PlanDetail = {
  end_at: string | null;
  status: PlanStatus;
  recurrence: string | null;
  series_id: string | null;
};

/** Place-kind detail payload. */
export type PlaceDetail = {
  address: string | null;
  latitude: number | null;
  longitude: number | null;
};

/** Kind-specific node detail; null for memory nodes without extra fields. */
export type NodeDetail = PersonDetail | PlanDetail | PlaceDetail | null;

/** Core Yaad node row. */
export type NodeRecord = {
  id: string;
  kind: NodeKind;
  title: string;
  body: string | null;
  occurred_at: string | null;
  expires_at: string | null;
  access_count: number;
  last_accessed_at: string | null;
  source: NodeSource;
  created_at: string;
  updated_at: string;
};

/** Directed edge between Yaad nodes. */
export type EdgeRecord = {
  id: string;
  src_id: string;
  dst_id: string;
  type: string;
  properties: Record<string, unknown>;
  confidence: number;
  created_at: string;
  valid_from: string;
  valid_to: string | null;
};

/** One field change in a node's history. */
export type NodeHistoryRecord = {
  id: string;
  node_id: string;
  field: "title" | "body" | "occurred_at" | "deleted";
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
  source: NodeSource;
};

/** POST /query body. */
export type QueryRequest = {
  kind?: NodeKind;
  name?: string;
  occurred_from?: string;
  occurred_to?: string;
  status?: PlanStatus;
  limit?: number;
  offset?: number;
};

/** POST /query response. */
export type QueryResponse = {
  nodes: Array<NodeRecord & { detail: NodeDetail }>;
  limit: number;
  offset: number;
};

/** POST /recall body. */
export type RecallRequest = {
  query: string;
  limit?: number;
};

/** POST /recall response with scored neighborhood. */
export type RecallResponse = {
  nodes: Array<
    NodeRecord & {
      detail: NodeDetail;
      hops: number;
      score: number;
    }
  >;
  edges: EdgeRecord[];
  coverage: number;
  sufficient: boolean;
  hops_taken: number;
  anchors: string[];
};

/** GET /nodes/:id response. */
export type NodeResponse = NodeRecord & {
  detail: NodeDetail;
  edges: { outgoing: EdgeRecord[]; incoming: EdgeRecord[] };
};
