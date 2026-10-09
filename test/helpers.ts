import { AGENT_ID_PATTERN } from "../src/agent-id.js";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { createDb, type Db, type Sql } from "../src/db/client.js";
import { agentTools, agents } from "../src/db/schema.js";
import { toolId } from "../src/tools/sync.js";
import type { DwarChatRequest, DwarChatResponse } from "../src/types/domain.js";
import type { DwarClient } from "../src/dwar/client.js";
import type { WakeLimits } from "../src/runtime/wake.js";
import type {
  ChaaviClient,
  ChaaviItem,
  ChaaviLogin,
  ChaaviPasskey,
  ChaaviSecret,
  CreateLoginRequest,
  ListItemsRequest,
} from "../src/chaavi/client.js";
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
  BrowserInfo,
  CaptureRequest,
  CreateBrowserRequest,
  CreateBrowserResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  EditFileRequest,
  ExecRequest,
  ExecResponse,
  GlobRequest,
  GrepRequest,
  KeysRequest,
  NasClient,
  ReadFileRequest,
  TerminalInfo,
  WriteFileRequest,
} from "../src/nas/client.js";
import type {
  IngestRequest,
  IngestResponse,
  RecallRequest,
  RecallResponse,
  YaadClient,
} from "../src/yaad/client.js";
import { syncTools } from "../src/tools/sync.js";
import { HathError } from "../src/errors.js";

export function testConfig(): Config {
  return loadConfig();
}

/** Wake limits no test wake reaches, for tests that are not about clearing tool results. */
/** A transcript window wide enough that tests see the whole thread. */
export const wideWindow = { chars: 1_000_000, stepChars: 1_000 };

export const roomyWakeLimits: WakeLimits = {
  toolResultsMaxChars: 1_000_000,
  toolResultsKeptChars: 500_000,
  supersedeWindowTurns: 8,
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

export function mockDwar(opts: {
  reason?: (
    request: DwarChatRequest,
  ) => DwarChatResponse | Promise<DwarChatResponse>;
  converse?: (
    request: DwarChatRequest,
  ) => DwarChatResponse | Promise<DwarChatResponse>;
  complete?: (
    request: DwarChatRequest,
  ) => DwarChatResponse | Promise<DwarChatResponse>;
  describeImage?: (request: {
    image: { media_type: string; data: string };
    prompt?: string;
  }) =>
    | { description: string; usage: { input_tokens: number; output_tokens: number } }
    | Promise<{
        description: string;
        usage: { input_tokens: number; output_tokens: number };
      }>;
}): DwarClient & {
  reasoningCalls: DwarChatRequest[];
  conversationCalls: DwarChatRequest[];
  completeCalls: DwarChatRequest[];
  describeCalls: Array<{
    image: { media_type: string; data: string };
    prompt?: string;
  }>;
} {
  const reasoningCalls: DwarChatRequest[] = [];
  const conversationCalls: DwarChatRequest[] = [];
  const completeCalls: DwarChatRequest[] = [];
  const describeCalls: Array<{
    image: { media_type: string; data: string };
    prompt?: string;
  }> = [];
  return {
    reasoningCalls,
    conversationCalls,
    completeCalls,
    describeCalls,
    async reason(request) {
      reasoningCalls.push(request);
      if (opts.reason) {
        return opts.reason(request);
      }
      return yieldTurn("reason-yield");
    },
    async converse(request) {
      conversationCalls.push(request);
      if (opts.converse) {
        return opts.converse(request);
      }
      return yieldTurn("converse-yield");
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
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
}

export function mockYaad(opts: {
  recall?: (body: RecallRequest) => Promise<RecallResponse> | RecallResponse;
  ingest?: (body: IngestRequest) => Promise<IngestResponse> | IngestResponse;
} = {}): YaadClient & {
  recallCalls: RecallRequest[];
  ingestCalls: IngestRequest[];
  searchHistoryCalls: Array<{ query: string; limit?: number }>;
} {
  const recallCalls: RecallRequest[] = [];
  const ingestCalls: IngestRequest[] = [];
  const searchHistoryCalls: Array<{ query: string; limit?: number }> = [];
  return {
    recallCalls,
    ingestCalls,
    searchHistoryCalls,
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
    async getNodeHistory() {
      return { history: [] };
    },
    async searchHistory(body) {
      searchHistoryCalls.push(body);
      return { results: [] };
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

/** Test double for ChaaviClient. Unstubbed getLogin/getPasskey/getSecret throw `not_found`. */
export function mockChaavi(
  opts: {
    listItems?: (
      query?: ListItemsRequest,
    ) => Promise<{ items: ChaaviItem[] }> | { items: ChaaviItem[] };
    createLogin?: (input: CreateLoginRequest) => Promise<ChaaviItem> | ChaaviItem;
    getLogin?: (itemId: string) => Promise<ChaaviLogin> | ChaaviLogin;
    getPasskey?: (itemId: string) => Promise<ChaaviPasskey> | ChaaviPasskey;
    getSecret?: (itemId: string) => Promise<ChaaviSecret> | ChaaviSecret;
  } = {},
): ChaaviClient & {
  listItemsCalls: Array<ListItemsRequest | undefined>;
  createLoginCalls: CreateLoginRequest[];
  getLoginCalls: string[];
  getPasskeyCalls: string[];
  getSecretCalls: string[];
} {
  const listItemsCalls: Array<ListItemsRequest | undefined> = [];
  const createLoginCalls: CreateLoginRequest[] = [];
  const getLoginCalls: string[] = [];
  const getPasskeyCalls: string[] = [];
  const getSecretCalls: string[] = [];
  return {
    listItemsCalls,
    createLoginCalls,
    getLoginCalls,
    getPasskeyCalls,
    getSecretCalls,
    async listItems(query) {
      listItemsCalls.push(query);
      if (opts.listItems) {
        return opts.listItems(query);
      }
      return { items: [] };
    },
    async createLogin(input) {
      createLoginCalls.push(input);
      if (opts.createLogin) {
        return opts.createLogin(input);
      }
      throw new HathError(500, "chaavi", "createLogin is not stubbed");
    },
    async getLogin(itemId) {
      getLoginCalls.push(itemId);
      if (opts.getLogin) {
        return opts.getLogin(itemId);
      }
      throw new HathError(404, "not_found", `item ${itemId} not found`);
    },
    async getPasskey(itemId) {
      getPasskeyCalls.push(itemId);
      if (opts.getPasskey) {
        return opts.getPasskey(itemId);
      }
      throw new HathError(404, "not_found", `item ${itemId} not found`);
    },
    async getSecret(itemId) {
      getSecretCalls.push(itemId);
      if (opts.getSecret) {
        return opts.getSecret(itemId);
      }
      throw new HathError(404, "not_found", `item ${itemId} not found`);
    },
  };
}

export function mockNas(opts: {
  createTerminal?: (
    body?: CreateTerminalRequest,
  ) => Promise<CreateTerminalResponse> | CreateTerminalResponse;
  listTerminals?: () => Promise<TerminalInfo[]> | TerminalInfo[];
  closeTerminal?: (id: string) => Promise<void> | void;
  exec?: (id: string, body: ExecRequest) => Promise<ExecResponse> | ExecResponse;
  capture?: (
    id: string,
    query?: CaptureRequest,
  ) => Promise<{ output: string }> | { output: string };
  sendKeys?: (
    id: string,
    body: KeysRequest,
  ) => Promise<{ sent: true }> | { sent: true };
  readFile?: (
    body: ReadFileRequest,
  ) =>
    | Promise<{ content: string; total_lines: number; truncated: boolean }>
    | { content: string; total_lines: number; truncated: boolean };
  writeFile?: (
    body: WriteFileRequest,
  ) => Promise<{ bytes: number }> | { bytes: number };
  editFile?: (
    body: EditFileRequest,
  ) => Promise<{ replaced: true }> | { replaced: true };
  glob?: (
    body: GlobRequest,
  ) => Promise<{ paths: string[]; truncated: boolean }> | { paths: string[]; truncated: boolean };
  grep?: (
    body: GrepRequest,
  ) =>
    | Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }>
    | { matches: Array<{ path: string; line: number; text: string }>; truncated: boolean };
  createBrowser?: (
    body?: CreateBrowserRequest,
  ) => Promise<CreateBrowserResponse> | CreateBrowserResponse;
  listBrowsers?: () => Promise<BrowserInfo[]> | BrowserInfo[];
  closeBrowser?: (id: number) => Promise<void> | void;
  browserScreenshot?: (id: number) => Promise<Buffer> | Buffer;
} = {}): NasClient & {
  createTerminalCalls: Array<CreateTerminalRequest | undefined>;
  listTerminalsCalls: number;
  closeTerminalCalls: string[];
  execCalls: Array<{ id: string; body: ExecRequest }>;
  captureCalls: Array<{ id: string; query?: CaptureRequest }>;
  sendKeysCalls: Array<{ id: string; body: KeysRequest }>;
  readFileCalls: ReadFileRequest[];
  writeFileCalls: WriteFileRequest[];
  editFileCalls: EditFileRequest[];
  globCalls: GlobRequest[];
  grepCalls: GrepRequest[];
  createBrowserCalls: number;
  listBrowsersCalls: number;
  closeBrowserCalls: number[];
  browserScreenshotCalls: number[];
} {
  const createTerminalCalls: Array<CreateTerminalRequest | undefined> = [];
  let listTerminalsCalls = 0;
  const closeTerminalCalls: string[] = [];
  const execCalls: Array<{ id: string; body: ExecRequest }> = [];
  const captureCalls: Array<{ id: string; query?: CaptureRequest }> = [];
  const sendKeysCalls: Array<{ id: string; body: KeysRequest }> = [];
  const readFileCalls: ReadFileRequest[] = [];
  const writeFileCalls: WriteFileRequest[] = [];
  const editFileCalls: EditFileRequest[] = [];
  const globCalls: GlobRequest[] = [];
  const grepCalls: GrepRequest[] = [];
  let createBrowserCalls = 0;
  let listBrowsersCalls = 0;
  const closeBrowserCalls: number[] = [];
  const browserScreenshotCalls: number[] = [];
  return {
    createTerminalCalls,
    get listTerminalsCalls() {
      return listTerminalsCalls;
    },
    closeTerminalCalls,
    execCalls,
    captureCalls,
    sendKeysCalls,
    readFileCalls,
    writeFileCalls,
    editFileCalls,
    globCalls,
    grepCalls,
    get createBrowserCalls() {
      return createBrowserCalls;
    },
    get listBrowsersCalls() {
      return listBrowsersCalls;
    },
    closeBrowserCalls,
    browserScreenshotCalls,
    async createTerminal(body) {
      createTerminalCalls.push(body);
      if (opts.createTerminal) {
        return opts.createTerminal(body);
      }
      return { id: "t1", cwd: "/var/lib/dadi" };
    },
    async listTerminals() {
      listTerminalsCalls += 1;
      if (opts.listTerminals) {
        return opts.listTerminals();
      }
      return [];
    },
    async closeTerminal(id) {
      closeTerminalCalls.push(id);
      if (opts.closeTerminal) {
        await opts.closeTerminal(id);
      }
    },
    async exec(id, body) {
      execCalls.push({ id, body });
      if (opts.exec) {
        return opts.exec(id, body);
      }
      return { exit_code: 0, output: "", truncated: false, timed_out: false };
    },
    async capture(id, query) {
      captureCalls.push({ id, query });
      if (opts.capture) {
        return opts.capture(id, query);
      }
      return { output: "" };
    },
    async sendKeys(id, body) {
      sendKeysCalls.push({ id, body });
      if (opts.sendKeys) {
        return opts.sendKeys(id, body);
      }
      return { sent: true };
    },
    async readFile(body) {
      readFileCalls.push(body);
      if (opts.readFile) {
        return opts.readFile(body);
      }
      return { content: "", total_lines: 0, truncated: false };
    },
    async writeFile(body) {
      writeFileCalls.push(body);
      if (opts.writeFile) {
        return opts.writeFile(body);
      }
      return { bytes: body.content.length };
    },
    async editFile(body) {
      editFileCalls.push(body);
      if (opts.editFile) {
        return opts.editFile(body);
      }
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
    async createBrowser(body) {
      createBrowserCalls += 1;
      if (opts.createBrowser) {
        return opts.createBrowser(body);
      }
      return {
        id: 10,
        display: ":10",
        cdp_url: "ws://127.0.0.1:9310/devtools/browser/test",
        downloads_dir: "/home/dadi/Downloads",
      };
    },
    async listBrowsers() {
      listBrowsersCalls += 1;
      if (opts.listBrowsers) {
        return opts.listBrowsers();
      }
      return [];
    },
    async closeBrowser(id) {
      closeBrowserCalls.push(id);
      if (opts.closeBrowser) {
        await opts.closeBrowser(id);
      }
    },
    async browserScreenshot(id) {
      browserScreenshotCalls.push(id);
      if (opts.browserScreenshot) {
        return opts.browserScreenshot(id);
      }
      // 1x1 PNG
      return Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
    },
    async getStatus() {
      return {
        uptime_seconds: 0,
        services: [],
        disk: { free_bytes: 0, total_bytes: 0 },
        errors: [],
      };
    },
    async getLogs() {
      return { entries: [] };
    },
    async restartModule() {
      return { status: "ok" };
    },
    async pullUpdates(scope) {
      return { state: "running", scope, started_at: "2026-01-01T00:00:00Z", reboot_required: false };
    },
    async getUpdateStatus() {
      return { state: "idle", reboot_required: false };
    },
    async stackUp() {
      return { status: "ok" };
    },
    async stackDown() {
      return { status: "ok" };
    },
    async provision(nodeName) {
      return { bundle: Buffer.from(JSON.stringify({ node_name: nodeName })).toString("base64") };
    },
    async listClients() {
      return { clients: [] };
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
  await sql`TRUNCATE scheduled_messages, messages, agent_logs, agent_tools, tools, agents CASCADE`;
  await syncTools(db);
}

/** Agent with an explicit grant list (tests state the capability under test). */
export async function insertWorker(
  db: Db,
  args: {
    id?: string;
    name?: string;
    systemPrompt: string;
    parentAgentId?: string | null;
    tools: readonly string[];
  },
): Promise<string> {
  const id = await insertAgent(db, args);
  for (const tool of args.tools) {
    await db.insert(agentTools).values({
      agentId: id,
      toolId: toolId(tool),
      usage: "test",
    });
  }
  return id;
}

/** Grant-, revoke-, and modify-children tools are embedded; spawning is the manager's grant. */
const MANAGER_TOOLS = ["hath_spawn_agent"] as const;

/** Agent that can spawn/grant/revoke/modify children. */
export async function insertManager(
  db: Db,
  args: { id?: string; name?: string; systemPrompt: string } = {
    id: "manager",
    systemPrompt: "manage children",
  },
): Promise<string> {
  const id = await insertAgent(db, args);
  for (const tool of MANAGER_TOOLS) {
    await db.insert(agentTools).values({
      agentId: id,
      toolId: toolId(tool),
      usage: "manage children",
    });
  }
  return id;
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
