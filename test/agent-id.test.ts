import assert from "node:assert/strict";
import { test } from "node:test";
import { agentIdOrUserSchema } from "../src/agent-id.js";

test("the user's name stands for the user, and an agent id stays an agent id", () => {
  for (const name of ["Ankur", "ankur", " ANKUR ", "user"]) {
    assert.equal(agentIdOrUserSchema.parse(name), null);
  }
  assert.equal(agentIdOrUserSchema.parse(null), null);
  assert.equal(agentIdOrUserSchema.parse("browser-manager"), "browser-manager");
});

test("anything else that is not an agent id is still refused", () => {
  for (const bad of ["Browser Manager", "Ankur Desai", "", 7]) {
    assert.equal(agentIdOrUserSchema.safeParse(bad).success, false);
  }
});
