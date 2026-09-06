/** Well-known id of root Dadi. */
export const ROOT_DADI_ID = "00000000-0000-4000-8000-000000000001";

export type Lane = "reasoning" | "conversation";

export type LogEvent = "thought" | "tool_call" | "tool_result" | "message";

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

export type AgentDetail = AgentRecord & {
  children: AgentRecord[];
  tools: Array<{ name: string; description: string; usage: string }>;
};

export type LogRecord = {
  id: string;
  agent_id: string;
  lane: Lane;
  event: LogEvent;
  payload: Record<string, unknown>;
  created_at: string;
};

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

export type NodeKind = "person" | "memory" | "plan" | "place";
export type NodeSource = "manual" | "agent" | "ingest";
export type PlanStatus = "idea" | "tentative" | "confirmed";

export type PersonDetail = {
  birthday: string | null;
  aliases: string[];
};

export type PlanDetail = {
  end_at: string | null;
  status: PlanStatus;
  recurrence: string | null;
  series_id: string | null;
};

export type PlaceDetail = {
  address: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type NodeDetail = PersonDetail | PlanDetail | PlaceDetail | null;

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

export type NodeHistoryRecord = {
  id: string;
  node_id: string;
  field: "title" | "body" | "occurred_at" | "deleted";
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
  source: NodeSource;
};

export type QueryRequest = {
  kind?: NodeKind;
  name?: string;
  occurred_from?: string;
  occurred_to?: string;
  status?: PlanStatus;
  limit?: number;
  offset?: number;
};

export type QueryResponse = {
  nodes: Array<NodeRecord & { detail: NodeDetail }>;
  limit: number;
  offset: number;
};

export type RecallRequest = {
  query: string;
  limit?: number;
};

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

export type NodeResponse = NodeRecord & {
  detail: NodeDetail;
  edges: { outgoing: EdgeRecord[]; incoming: EdgeRecord[] };
};
