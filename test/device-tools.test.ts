import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { migrate } from "../src/db/migrate.js";
import { allTools, findTool } from "../src/tools/registry.js";
import { syncTools } from "../src/tools/sync.js";
import {
  insertWorker,
  mockDwar,
  mockGhar,
  mockChaavi,
  mockNas,
  mockYaad,
  openTestDb,
  resetRuntime,
  silentLog,
  testConfig,
} from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
  await resetRuntime(handle.sql, handle.db, config);
});

after(async () => {
  await handle.close();
});

const DEVICE_TOOLS = [
  "nas_list_clients",
  "device_get_info",
  "device_get_battery",
  "device_get_location",
  "device_get_network",
] as const;

test("device tools are registered", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  for (const name of DEVICE_TOOLS) {
    assert.equal(findTool(name)?.name, name);
  }
  assert.equal(allTools().length, 52);
  await assert.doesNotReject(() => syncTools(handle.db));
});

test("nas_list_clients returns Nas mesh clients", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["nas_list_clients"],
  });
  const nas = mockNas();
  nas.listClients = async () => ({
    clients: [
      {
        node_name: "ankur-phone",
        online: true,
        last_seen: "2026-01-02T03:04:05Z",
        ip_addresses: ["100.64.0.5"],
      },
    ],
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "lc1",
    name: "nas_list_clients",
    input: {},
  });
  assert.equal(result.isError, false);
  const body = JSON.parse(result.content);
  assert.equal(body.clients[0].node_name, "ankur-phone");
});

/** A Nas whose mesh holds the box, a phone with the app open, and a laptop that is off. */
function surveyNas() {
  const nas = mockNas();
  nas.listClients = async () => ({
    clients: [
      { node_name: "os", online: true, last_seen: null, ip_addresses: ["100.64.0.1"] },
      { node_name: "ankur-phone", online: true, last_seen: "2026-01-02T03:04:05Z", ip_addresses: ["100.64.0.5"] },
      { node_name: "ankur-laptop", online: false, last_seen: "2026-01-01T00:00:00Z", ip_addresses: ["100.64.0.6"] },
    ],
  });
  return nas;
}

test("device_get_battery surveys every enrolled device and only asks running apps", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["device_get_battery"],
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: surveyNas(),
    config,
    log: silentLog,
  });
  runtime.devices.setPresence({ node_name: "ankur-phone", platform: "ios", app_version: "1.0.0" });

  const asked: string[] = [];
  const unsubscribe = runtime.events.subscribe((event) => {
    if (event.type !== "device_command") {
      return;
    }
    asked.push(event.node_name);
    assert.equal(event.tool, "device_get_battery");
    runtime.devices.complete(event.command_id, {
      ok: true,
      result: { percent: 81, charging: true },
    });
  });

  try {
    const result = await executeTool(runtime.toolContext(workerId, "reasoning"), {
      type: "tool_use",
      id: "bat1",
      name: "device_get_battery",
      input: {},
    });
    assert.equal(result.isError, false);
    assert.deepEqual(asked, ["ankur-phone"]);
    assert.deepEqual(JSON.parse(result.content), {
      devices: [
        {
          node_name: "ankur-phone",
          online: true,
          last_seen: "2026-01-02T03:04:05Z",
          app_running: true,
          result: { percent: 81, charging: true },
        },
        {
          node_name: "ankur-laptop",
          online: false,
          last_seen: "2026-01-01T00:00:00Z",
          app_running: false,
        },
      ],
    });
  } finally {
    unsubscribe();
  }
});

test("a running app's failure stays on its own device line", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["device_get_location"],
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: mockChaavi(),
    nas: surveyNas(),
    config,
    log: silentLog,
  });
  runtime.devices.setPresence({ node_name: "ankur-phone", platform: "ios", app_version: "1.0.0" });

  const unsubscribe = runtime.events.subscribe((event) => {
    if (event.type !== "device_command") {
      return;
    }
    runtime.devices.complete(event.command_id, {
      ok: false,
      error: { type: "permission_denied", message: "location blocked" },
    });
  });

  try {
    const result = await executeTool(runtime.toolContext(workerId, "reasoning"), {
      type: "tool_use",
      id: "loc1",
      name: "device_get_location",
      input: {},
    });
    assert.equal(result.isError, false);
    const phone = JSON.parse(result.content).devices[0];
    assert.equal(phone.node_name, "ankur-phone");
    assert.deepEqual(phone.error, { type: "permission_denied", message: "location blocked" });
  } finally {
    unsubscribe();
  }
});
