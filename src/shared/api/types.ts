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

/** Response from Dimaag POST /dadi. */
export type PostDadiResponse =
  | {
      action: "routed";
      thread_id: string;
      created: boolean;
      content: string;
      seq: number;
      created_at: string;
    }
  | {
      action: "modified";
      agent_id: string;
      active: boolean;
      system_prompt: string;
    };

/** Nas browsers/terminals this agent recently drove. Empty after Dimaag restart. */
export type AgentSessions = {
  browsers: number[];
  terminals: Array<{ id: string; last_command: string | null }>;
};

/** Flat agent row from GET /agents. */
export type AgentRecord = {
  id: string;
  name: string;
  system_prompt: string;
  parent_agent_id: string | null;
  active: boolean;
  running: { reasoning: boolean; conversation: boolean };
  sessions: AgentSessions;
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

/** GET /health — process liveness and start time for live-transcript alignment. */
export type DimaagHealth = {
  status: string;
  /** ISO time this Dimaag process started; chat older than this is not in the live transcript. */
  started_at: string;
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
      type: "lane_failed";
      agent_id: string;
      lane: Lane;
      message: string;
      at: string;
    }
  | { type: "dadi_started"; at: string }
  | { type: "dadi_finished"; at: string }
  | { type: "dadi_failed"; message: string; at: string }
  | {
      type: "agent_spawned";
      agent_id: string;
      parent_agent_id: string | null;
      name: string;
      at: string;
    }
  | {
      type: "agent_modified";
      agent_id: string;
      name: string;
      active: boolean;
      at: string;
    }
  | {
      type: "hath_command";
      command_id: string;
      node_name: string;
      tool: string;
      args: Record<string, unknown>;
      at: string;
    };

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

/** Vault item classification in the Chaavi catalog. */
export type ChaaviItemKind = "login" | "note" | "secret";

/**
 * Catalog row from Chaavi GET /v1/items.
 * Metadata only — never a password or secret body (use revealLogin).
 */
export type ChaaviItem = {
  /** Vault item id. */
  id: string;
  /** Display name. */
  name: string;
  /** Item classification. */
  kind: ChaaviItemKind;
  /** Login username when present; null for notes/secrets without one. */
  username: string | null;
  /** Associated URIs. */
  uris: string[];
  /** True when a login stores a FIDO2 passkey. */
  hasPasskey: boolean;
};

/** Body for Chaavi POST /v1/logins. */
export type ChaaviCreateLogin = {
  name: string;
  username: string;
  uri?: string;
  /** When omitted, Chaavi generates a password. */
  password?: string;
  length?: number;
  special?: boolean;
};

/** Body for Chaavi PATCH /v1/items/:id (login). At least one field required. */
export type ChaaviUpdateLogin = {
  name?: string;
  username?: string;
  /** Empty string clears websites. */
  uri?: string;
  password?: string;
};

/** Decrypt-on-demand login from Chaavi POST /v1/items/:id/login. */
export type ChaaviLoginCredential = {
  username: string;
  password: string;
};

/** GET /health — process is up; vault may still be unconfigured. */
export type ChaaviHealth = {
  /** Process liveness string from Chaavi. */
  status: string;
  /** Whether a vault is configured on this node. */
  vault: "ready" | "unconfigured";
};

/** Ghar capability name on a device. */
export type GharCapabilityName =
  | "switchable"
  | "dimmable"
  | "colorable"
  | "sensor"
  | "lockable"
  | "media"
  | "thermostat";

/** Live attribute from Ghar GET /devices. */
export type GharAttributeState = {
  value: unknown;
  changed_at: string;
};

/** Device row from Ghar GET /devices. */
export type GharDevice = {
  id: string;
  name: string;
  /** Matter product string. Quiet subtitle; the row `name` is the device's own label. */
  product_name: string | null;
  room: { id: string; name: string };
  capabilities: Array<{
    capability: GharCapabilityName;
    /** Capability config from Ghar, such as color `modes`. */
    config?: Record<string, unknown>;
  }>;
  online: boolean;
  last_seen_at: string | null;
  state: Record<string, GharAttributeState>;
};

/** Room row from Ghar GET /rooms. */
export type GharRoom = {
  id: string;
  name: string;
};

/** Commission job status from Ghar. */
export type GharCommissionStatus =
  | "pending"
  | "discovering"
  | "commissioning"
  | "succeeded"
  | "failed";

/** Job payload from GET /commission/:jobId. Wi-Fi credentials are never included. */
export type GharCommissionJob = {
  id: string;
  status: GharCommissionStatus;
  node_id: string | null;
  device_ids: string[] | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

/** One Bluetooth command Ghar asks this computer to run. */
export type GharRadioCommand = {
  id: number;
  name: "scan" | "stop_scan" | "connect" | "disconnect" | "write" | "subscribe";
  args: Record<string, string>;
};
