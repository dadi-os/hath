import assert from "node:assert/strict";
import { test } from "node:test";
import { HostSessions } from "../src/runtime/sessions.js";
import { mockNas } from "./helpers.js";

test("an agent's sessions are the Nas tasks it owns or last steered, read live", async () => {
  const nas = mockNas();
  const sessions = new HostSessions(nas);
  await nas.startTask("browser", { agent_id: "a1", message: "open the portal" });
  await nas.startTask("terminal", { agent_id: "a2", message: "run tests" });
  await nas.startTask("browser", { agent_id: "a2", message: "other" });
  await nas.steerTask("browser", "3", { agent_id: "a1", message: "take over" });

  const snapshot = await sessions.snapshot();
  const a1 = sessions.forAgent(snapshot, "a1").tasks.map((task) => task.id);
  assert.deepEqual(a1.sort(), ["task/browser/1", "task/browser/3"]);
  assert.deepEqual(sessions.forAgent(snapshot, "a2").tasks.map((task) => task.id).sort(), ["task/browser/3", "task/terminal/2"]);
  assert.deepEqual(sessions.forAgent(snapshot, "nobody").tasks, []);

  const task = sessions.forAgent(snapshot, "a1").tasks.find((entry) => entry.id === "task/browser/1");
  assert.equal(task?.kind, "browser");
  assert.equal(task?.status, "working");
  assert.equal(task?.purpose, "open the portal");
});
