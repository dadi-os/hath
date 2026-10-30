import { AGENT_ID_PATTERN } from "../src/agent-id.js";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { createDb, type Db, type Sql } from "../src/db/client.js";
import { agents } from "../src/db/schema.js";
import type { DwarChatRequest, DwarChatResponse } from "../src/types/domain.js";
import type { DwarClient, DwarDescribeImageResponse } from "../src/dwar/client.js";
import type { WakeLimits } from "../src/runtime/wake.js";
import type {
  CommandRequest,
  GharAttributeState,
  GharClient,
  GharDevice,
  GharEvent,
  ListDevicesRequest,
  ListEventsRequest,
} from "../src/ghar/client.js";
import type {
  EditFileRequest,
  ExecRequest,
  ExecResponse,
  GlobRequest,
  GrepRequest,
  HelperTask,
  NasClient,
  NasEvent,
  ReadFileBytesRequest,
  ReadFileRequest,
  TaskKind,
  TaskRequest,
  WriteFileRequest,
} from "../src/nas/client.js";
import type {
  IngestRequest,
  IngestResponse,
  RecallRequest,
  RecallResponse,
  YaadClient,
} from "../src/yaad/client.js";
import { HathError } from "../src/errors.js";

export function testConfig(): Config {
  return loadConfig();
}

/** Transcript windows wide enough that tests see the whole thread on both lanes. */
export const wideWindows = {
  process: { chars: 1_000_000, stepChars: 1_000, budgetTokens: 10_000_000 },
  work: { chars: 1_000_000, stepChars: 1_000, budgetTokens: 10_000_000 },
};

/** Wake limits no test wake reaches, for tests that are not about clearing tool results. */
export const roomyWakeLimits: WakeLimits = {
  toolResultsMaxChars: 1_000_000,
  toolResultsKeptChars: 500_000,
  supersedeWindowTurns: 8,
  promptCeilingTokens: 10_000_000,
  promptTrimTokens: 1_000_000,
  filesDir: "/files",
};

export const silentLog = {
  error() {},
  info() {},
  warn() {},
};

const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** A turn with no tool call. In a lane loop it continues; it never ends the lane. */
export function endTurn(text = "ok"): DwarChatResponse {
  return {
    provider: "anthropic",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage,
  };
}

export function toolUse(name: string, input: unknown, id = "call-1"): DwarChatResponse {
  return {
    provider: "anthropic",
    content: [{ type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    usage,
  };
}

/** Default mock lane exit — call the embedded yield tool. */
export function yieldTurn(id = "yield-1"): DwarChatResponse {
  return toolUse("yield", {}, id);
}

/** The id of the newest work-lane message to `to` that a process-lane request shows in a [Messages from work] turn. */
export function waitingMessageId(request: DwarChatRequest, to = "Ankur"): number {
  const found = [...JSON.stringify(request.messages).matchAll(new RegExp(`#(\\d+) · to ${to}(?: ·|\\\\n)`, "g"))].at(-1);
  if (found === undefined) {
    throw new Error(`no message from work to ${to} is waiting in the request`);
  }
  return Number(found[1]);
}

export function mockDwar(opts: {
  work?: (
    request: DwarChatRequest,
  ) => DwarChatResponse | Promise<DwarChatResponse>;
  process?: (
    request: DwarChatRequest,
  ) => DwarChatResponse | Promise<DwarChatResponse>;
  complete?: (
    request: DwarChatRequest,
  ) => DwarChatResponse | Promise<DwarChatResponse>;
  describeImage?: (request: {
    image: { media_type: string; data: string };
    prompt?: string;
  }) =>
    DwarDescribeImageResponse | Promise<DwarDescribeImageResponse>;
}): DwarClient & {
  workCalls: DwarChatRequest[];
  processCalls: DwarChatRequest[];
  completeCalls: DwarChatRequest[];
  describeCalls: Array<{
    image: { media_type: string; data: string };
    prompt?: string;
  }>;
} {
  const workCalls: DwarChatRequest[] = [];
  const processCalls: DwarChatRequest[] = [];
  const completeCalls: DwarChatRequest[] = [];
  const describeCalls: Array<{
    image: { media_type: string; data: string };
    prompt?: string;
  }> = [];
  return {
    workCalls,
    processCalls,
    completeCalls,
    describeCalls,
    async work(request) {
      workCalls.push(request);
      if (opts.work) {
        return opts.work(request);
      }
      return yieldTurn("work-yield");
    },
    async process(request) {
      processCalls.push(request);
      if (opts.process) {
        return opts.process(request);
      }
      return yieldTurn("process-yield");
    },
    async complete(request) {
      completeCalls.push(request);
      if (opts.complete) {
        return opts.complete(request);
      }
      return yieldTurn("complete-yield");
    },
    async describeImage(request) {
      describeCalls.push(request);
      if (opts.describeImage) {
        return opts.describeImage(request);
      }
      return {
        description: "mock image description",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    },
    async webSearch() {
      throw new Error("mockDwar.webSearch is not stubbed");
    },
    async webFetch() {
      throw new Error("mockDwar.webFetch is not stubbed");
    },
  };
}

export function mockYaad(opts: {
  recall?: (body: RecallRequest) => Promise<RecallResponse> | RecallResponse;
  ingest?: (body: IngestRequest) => Promise<IngestResponse> | IngestResponse;
} = {}): YaadClient & {
  recallCalls: RecallRequest[];
  ingestCalls: IngestRequest[];
} {
  const recallCalls: RecallRequest[] = [];
  const ingestCalls: IngestRequest[] = [];
  return {
    recallCalls,
    ingestCalls,
    async recall(body) {
      recallCalls.push(body);
      if (opts.recall) {
        return opts.recall(body);
      }
      return {
        nodes: [],
        edges: [],
        sufficient: false,
        coverage: 0,
      };
    },
    async ingest(body) {
      ingestCalls.push(body);
      if (opts.ingest) {
        return opts.ingest(body);
      }
      return {
        counts: {
          create_node: 0,
          update_node: 0,
          close_node: 0,
          create_edge: 0,
          close_edge: 0,
          noop: 1,
        },
        operations: [{ op: "noop", reason: "nothing" }],
      };
    },
  };
}

export function mockGhar(opts: {
  listDevices?: (
    query?: ListDevicesRequest,
  ) => Promise<{ devices: GharDevice[] }> | { devices: GharDevice[] };
  getState?: () =>
    | Promise<{ devices: Record<string, Record<string, GharAttributeState>> }>
    | { devices: Record<string, Record<string, GharAttributeState>> };
  command?: (
    deviceId: string,
    body: CommandRequest,
  ) => Promise<{ ok: true }> | { ok: true };
  listEvents?: (
    query?: ListEventsRequest,
  ) => Promise<{ events: GharEvent[] }> | { events: GharEvent[] };
} = {}): GharClient & {
  listDevicesCalls: Array<ListDevicesRequest | undefined>;
  getStateCalls: number;
  commandCalls: Array<{ deviceId: string; body: CommandRequest }>;
  listEventsCalls: Array<ListEventsRequest | undefined>;
} {
  const listDevicesCalls: Array<ListDevicesRequest | undefined> = [];
  let getStateCalls = 0;
  const commandCalls: Array<{ deviceId: string; body: CommandRequest }> = [];
  const listEventsCalls: Array<ListEventsRequest | undefined> = [];
  return {
    listDevicesCalls,
    get getStateCalls() {
      return getStateCalls;
    },
    commandCalls,
    listEventsCalls,
    async listDevices(query) {
      listDevicesCalls.push(query);
      if (opts.listDevices) {
        return opts.listDevices(query);
      }
      return { devices: [] };
    },
    async getState() {
      getStateCalls += 1;
      if (opts.getState) {
        return opts.getState();
      }
      return { devices: {} };
    },
    async command(deviceId, body) {
      commandCalls.push({ deviceId, body });
      if (opts.command) {
        return opts.command(deviceId, body);
      }
      return { ok: true };
    },
    async listEvents(query) {
      listEventsCalls.push(query);
      if (opts.listEvents) {
        return opts.listEvents(query);
      }
      return { events: [] };
    },
  };
}

/**
 * A Nas double. Files live in memory (`files`): writeFile and editFile change them and
 * readFile, readFileBytes read them. Helper tasks live in memory too (`tasks`): startTask
 * and steerTask create and change them, and `emit` pushes an event down the stream
 * openReports returns. Anything else is stubbed through `opts`.
 */
export function mockNas(opts: {
  exec?: (id: string, body: ExecRequest) => Promise<ExecResponse> | ExecResponse;
  readFile?: (
    body: ReadFileRequest,
  ) =>
    | Promise<{ content: string; total_lines: number; truncated: boolean }>
    | { content: string; total_lines: number; truncated: boolean };
  glob?: (
    body: GlobRequest,
  ) => Promise<{ paths: string[]; truncated: boolean }> | { paths: string[]; truncated: boolean };
  grep?: (
    body: GrepRequest,
  ) =>
    | Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }>
    | { matches: Array<{ path: string; line: number; text: string }>; truncated: boolean };
  /** Make every file read fail with this error. */
  readError?: HathError;
} = {}): NasClient & {
  files: Map<string, Buffer>;
  tasks: Map<string, HelperTask>;
  startTaskCalls: Array<{ kind: TaskKind; body: TaskRequest }>;
  steerTaskCalls: Array<{ kind: TaskKind; id: string; body: TaskRequest }>;
  execCalls: Array<{ id: string; body: ExecRequest }>;
  terminalsCreated: string[];
  terminalsClosed: string[];
  readFileBytesCalls: ReadFileBytesRequest[];
  writeFileCalls: WriteFileRequest[];
  editFileCalls: EditFileRequest[];
  globCalls: GlobRequest[];
  grepCalls: GrepRequest[];
  /** Whether a stream from openReports is open. */
  streamOpen: () => boolean;
  /** Push an event to the open stream. */
  emit: (event: NasEvent) => void;
  /** End the open stream with an error, as a dropped connection does. */
  dropStream: (error: Error) => void;
  /** How many times openReports was called. */
  opens: () => number;
} {
  const files = new Map<string, Buffer>();
  const tasks = new Map<string, HelperTask>();
  const startTaskCalls: Array<{ kind: TaskKind; body: TaskRequest }> = [];
  const steerTaskCalls: Array<{ kind: TaskKind; id: string; body: TaskRequest }> = [];
  const execCalls: Array<{ id: string; body: ExecRequest }> = [];
  const terminalsCreated: string[] = [];
  const terminalsClosed: string[] = [];
  const readFileBytesCalls: ReadFileBytesRequest[] = [];
  const writeFileCalls: WriteFileRequest[] = [];
  const editFileCalls: EditFileRequest[] = [];
  const globCalls: GlobRequest[] = [];
  const grepCalls: GrepRequest[] = [];
  let counter = 0;
  let opens = 0;
  let push: ((event: NasEvent) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;

  const view = (kind: TaskKind, id: string, body: TaskRequest): HelperTask => {
    const now = new Date().toISOString();
    return {
      task: `task/${kind}/${id}`,
      kind,
      id,
      owner: body.agent_id,
      steered_by: body.agent_id,
      purpose: body.message,
      status: "working",
      state: "",
      created_at: now,
      last_activity: now,
    };
  };
  const notFound = (path: string) => new HathError(404, "not_found", `${path} not found`);

  return {
    files,
    tasks,
    startTaskCalls,
    steerTaskCalls,
    execCalls,
    terminalsCreated,
    terminalsClosed,
    readFileBytesCalls,
    writeFileCalls,
    editFileCalls,
    globCalls,
    grepCalls,
    streamOpen: () => push !== undefined,
    emit: (event) => push?.(event),
    dropStream: (error) => fail?.(error),
    opens: () => opens,
    async startTask(kind, body) {
      startTaskCalls.push({ kind, body });
      counter += 1;
      const task = view(kind, String(counter), body);
      tasks.set(task.task, task);
      return task;
    },
    async steerTask(kind, id, body) {
      steerTaskCalls.push({ kind, id, body });
      const existing = tasks.get(`task/${kind}/${id}`);
      if (!existing) {
        throw new HathError(404, "not_found", `no task ${kind}/${id}`);
      }
      const task: HelperTask = { ...existing, steered_by: body.agent_id, status: "working" };
      tasks.set(task.task, task);
      return task;
    },
    async listTasks() {
      return [...tasks.values()];
    },
    async getTask(kind, id) {
      const task = tasks.get(`task/${kind}/${id}`);
      if (!task) {
        throw new HathError(404, "not_found", `no task ${kind}/${id}`);
      }
      return task;
    },
    async openReports(signal) {
      opens += 1;
      const queue: NasEvent[] = [];
      let wake: (() => void) | undefined;
      let failure: Error | undefined;
      push = (event) => {
        queue.push(event);
        wake?.();
      };
      fail = (error) => {
        failure = error;
        wake?.();
      };
      signal.addEventListener("abort", () => {
        failure = new Error("aborted");
        wake?.();
      });
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              const next = queue.shift();
              if (next !== undefined) {
                yield next;
                continue;
              }
              if (failure !== undefined) {
                throw failure;
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = undefined;
            }
          } finally {
            push = undefined;
            fail = undefined;
          }
        },
      };
    },
    async createTerminal(cwd) {
      const id = `t${terminalsCreated.length + 1}`;
      terminalsCreated.push(id);
      return { id, cwd: cwd ?? "/" };
    },
    async closeTerminal(id) {
      terminalsClosed.push(id);
    },
    async exec(id, body) {
      execCalls.push({ id, body });
      if (opts.exec) {
        return opts.exec(id, body);
      }
      return { exit_code: 0, output: "", truncated: false, timed_out: false };
    },
    async readFile(body) {
      if (opts.readFile) {
        return opts.readFile(body);
      }
      return { content: "", total_lines: 0, truncated: false };
    },
    async readFileBytes(body) {
      readFileBytesCalls.push(body);
      if (opts.readError) {
        throw opts.readError;
      }
      const bytes = files.get(body.path);
      if (bytes === undefined) {
        throw notFound(body.path);
      }
      if (bytes.length > body.max_bytes) {
        throw new HathError(400, "invalid_request", `${body.path} is ${bytes.length} bytes, over max_bytes ${body.max_bytes}`);
      }
      return { data: bytes.toString("base64"), size_bytes: bytes.length };
    },
    async writeFile(body) {
      writeFileCalls.push(body);
      const bytes = "data" in body ? Buffer.from(body.data, "base64") : Buffer.from(body.content, "utf8");
      files.set(body.path, bytes);
      return { bytes: bytes.length };
    },
    async editFile(body) {
      editFileCalls.push(body);
      const bytes = files.get(body.path);
      if (bytes === undefined) {
        throw notFound(body.path);
      }
      const text = bytes.toString("utf8");
      const count = text.split(body.old_string).length - 1;
      if (count !== 1) {
        throw new HathError(409, "conflict", `old_string occurs ${count} times in ${body.path}; it must occur exactly once`);
      }
      files.set(body.path, Buffer.from(text.replace(body.old_string, () => body.new_string), "utf8"));
      return { replaced: true };
    },
    async glob(body) {
      globCalls.push(body);
      if (opts.glob) {
        return opts.glob(body);
      }
      return { paths: [], truncated: false };
    },
    async grep(body) {
      grepCalls.push(body);
      if (opts.grep) {
        return opts.grep(body);
      }
      return { matches: [], truncated: false };
    },
  };
}

export async function openTestDb(): Promise<{ db: Db; sql: Sql; close: () => Promise<void> }> {
  const config = loadConfig();
  const { client, db } = createDb(config.env.databaseUrl);
  return {
    db,
    sql: client,
    close: () => client.end(),
  };
}

export async function resetRuntime(sql: Sql, db: Db, _config: Config): Promise<void> {
  await sql`TRUNCATE delivered_reports, scheduled_messages, messages, agent_logs, agents CASCADE`;
}

/** insertAgent creates an agent row; `id` is kebab-case (`name` accepted as alias). */
export async function insertAgent(
  db: Db,
  args: {
    id?: string;
    name?: string;
    systemPrompt: string;
    parentAgentId?: string | null;
  },
): Promise<string> {
  const id = args.id ?? args.name;
  if (id === undefined) {
    throw new Error("insertAgent requires id (or name alias)");
  }
  if (!AGENT_ID_PATTERN.test(id)) {
    throw new Error(
      `insertAgent id must be kebab-case matching ${AGENT_ID_PATTERN}: got ${JSON.stringify(id)}`,
    );
  }
  await db.insert(agents).values({
    id,
    systemPrompt: args.systemPrompt,
    parentAgentId: args.parentAgentId ?? null,
    active: true,
  });
  return id;
}

/** The work loop's wake hooks, doing nothing: a lane with no watch and no requester waiting. */
export const workLoopHooks = {
  woke: async () => {},
  yieldReminder: async () => null,
};
