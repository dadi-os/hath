import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { CONTROL_WAIT_MS } from "../src/constants.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { migrate } from "../src/db/migrate.js";
import { pendingAsync } from "../src/db/schema.js";
import { findTool } from "../src/tools/registry.js";
import { HathError } from "../src/errors.js";
import type { GharDevice } from "../src/ghar/client.js";
import {
  insertAgent,
  mockDwar,
  mockGhar,
  mockNas,
  mockYaad,
  openTestDb,
  resetRuntime,
  silentLog,
  testConfig,
  yieldTurn,
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

function device(name: string, brightness: number): GharDevice {
  return {
    id: randomUUID(),
    node_id: "1",
    endpoint: 1,
    name,
    kind: "light",
    device_types: [0x0101],
    bridge_name: "Hue Bridge",
    tags: [{ id: randomUUID(), name: "lighting" }],
    capabilities: [{ capability: "level", config: { min: 0, max: 100 } }],
    online: true,
    last_seen_at: "2026-09-08T12:00:00.000Z",
    vendor_name: null,
    product_name: null,
    state: { brightness: { value: brightness, changed_at: "2026-09-08T12:00:00.000Z" } },
  };
}

function runtimeWith(ghar: ReturnType<typeof mockGhar>, dwar = mockDwar({})) {
  return createRuntime({ db: handle.db, dwar, yaad: mockYaad(), ghar, nas: mockNas(), config, log: silentLog });
}

const call = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });

test("the two Ghar tools are registered and the old four are not", () => {
  for (const name of ["get_device", "control_device"]) {
    assert.equal(findTool(name)?.name, name);
  }
  for (const name of ["ghar_list_devices", "ghar_get_state", "ghar_control_device", "ghar_get_device_events"]) {
    assert.equal(findTool(name), undefined, name);
  }
});

test("get_device with no ids lists every device, capabilities and state together", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertAgent(handle.db, { name: "thread", systemPrompt: "do the job" });
  const hall = device("Hall bulb", 40);
  const ghar = mockGhar({ listDevices: () => ({ devices: [hall] }) });
  const result = await executeTool(runtimeWith(ghar).toolContext(workerId, "work"), call("gd1", "get_device", {}));
  assert.equal(result.isError, false);
  assert.deepEqual(ghar.listDevicesCalls, [undefined]);
  const body = JSON.parse(result.content);
  assert.equal(body.devices[0].id, hall.id);
  assert.equal(body.devices[0].capabilities[0].capability, "level");
  assert.equal(body.devices[0].state.brightness.changed_at, "2026-09-08T12:00:00.000Z");
});

test("get_device with ids reads exactly those devices and not the list", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertAgent(handle.db, { name: "thread", systemPrompt: "do the job" });
  const a = device("A", 10);
  const b = device("B", 20);
  const ghar = mockGhar({ getDevice: (id) => (id === a.id ? a : b) });
  const result = await executeTool(runtimeWith(ghar).toolContext(workerId, "process"), call("gd2", "get_device", { device_ids: [a.id, b.id] }));
  assert.equal(result.isError, false);
  assert.deepEqual(ghar.getDeviceCalls, [a.id, b.id]);
  assert.equal(ghar.listDevicesCalls.length, 0);
  assert.deepEqual(JSON.parse(result.content).devices.map((d: { name: string }) => d.name), ["A", "B"]);
});

test("Ghar unreachable fails get_device with the ghar code, not an empty success", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertAgent(handle.db, { name: "thread", systemPrompt: "do the job" });
  const ghar = mockGhar({
    listDevices: () => {
      throw new HathError(502, "ghar", "Ghar is unreachable");
    },
  });
  const result = await executeTool(runtimeWith(ghar).toolContext(workerId, "work"), call("gd3", "get_device", {}));
  assert.equal(result.isError, true);
  assert.match(result.content, /^ghar:.*unreachable/i);
});

test("control_device sends the request attributed to the calling agent, not its parent, and returns Ghar's answer", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const parentId = await insertAgent(handle.db, { name: "parent", systemPrompt: "parent" });
  const childId = await insertAgent(handle.db, { name: "house-thread", systemPrompt: "control lights", parentAgentId: parentId });
  const ghar = mockGhar({ control: () => ({ id: randomUUID(), status: "done", result: "Hall light is at 40%." }) });
  const result = await executeTool(runtimeWith(ghar).toolContext(childId, "work"), call("cd1", "control_device", { request: "hall light to 40" }));
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content), { result: "Hall light is at 40%." });
  assert.deepEqual(ghar.controlCalls, [{ request: "hall light to 40", caller: childId, wait_ms: CONTROL_WAIT_MS }]);
});

test("a control run Ghar could not finish is a tool error carrying its type", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { name: "thread", systemPrompt: "do the job" });
  const ghar = mockGhar({
    control: () => ({ id: randomUUID(), status: "failed", error: { type: "control_failed", message: "no tool call" } }),
  });
  const result = await executeTool(runtimeWith(ghar).toolContext(agentId, "process"), call("cd2", "control_device", { request: "x" }));
  assert.equal(result.isError, true);
  assert.equal(result.content, "control_failed: no tool call");
});

test("a slow control run returns pending, then its answer wakes the lane that asked", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "house-asker", systemPrompt: "runs the house" });
  const runId = randomUUID();
  const ghar = mockGhar({
    control: () => ({ id: runId, status: "running" }),
    getControl: () => ({ id: runId, status: "done", result: "Garage door is closed." }),
  });
  const dwar = mockDwar({ process: () => yieldTurn(), work: () => yieldTurn() });
  const runtime = runtimeWith(ghar, dwar);
  const started = await executeTool(runtime.toolContext(agentId, "process"), call("cd3", "control_device", { request: "close the garage" }));
  assert.equal(started.isError, false);
  assert.equal(JSON.parse(started.content).pending, "cd3");
  const [row] = await handle.db.select().from(pendingAsync).where(eq(pendingAsync.id, "cd3"));
  assert.equal(row?.lane, "process");
  await runtime.waitUntilIdle();
  assert.equal((await handle.db.select().from(pendingAsync)).length, 0);
  assert.match(runtime.transcript.transcriptFor(agentId).at(-1)!.content, /^Result of control_device \(cd3\), done:\n.*Garage door is closed\./);
  assert.equal(dwar.workCalls.length, 0, "the work lane did not wake");
  assert.equal(dwar.processCalls.length, 1, "the process lane woke for the answer");
  assert.match(JSON.stringify(dwar.processCalls[0]!.messages), /Woken by: async tool result \(control_device cd3\)/);
});

test("a device change the process lane made reaches the work lane as a note, and a read does not", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const agentId = await insertAgent(handle.db, { id: "house-noter", systemPrompt: "runs the house" });
  const hall = device("Hall bulb", 40);
  const ghar = mockGhar({
    getDevice: () => hall,
    control: () => ({ id: randomUUID(), status: "done", result: "Hall light is off." }),
  });
  const dwar = mockDwar({ process: () => yieldTurn(), work: () => yieldTurn() });
  const runtime = runtimeWith(ghar, dwar);
  const context = runtime.toolContext(agentId, "process");
  await executeTool(context, call("n1", "get_device", { device_ids: [hall.id] }));
  assert.equal(runtime.transcript.transcriptFor(agentId).length, 0);
  await executeTool(context, call("n2", "control_device", { request: "hall light off" }));
  const note = runtime.transcript.transcriptFor(agentId).at(-1)!;
  assert.equal(note.kind, "notice");
  assert.match(note.content, /^Your process lane ran control_device hall light off: .*Hall light is off\./);
  await runtime.waitUntilIdle();
  assert.equal(dwar.processCalls.length + dwar.workCalls.length, 0, "the note woke no lane");
});
