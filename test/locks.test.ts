import assert from "node:assert/strict";
import { test } from "node:test";
import { RunLocks } from "../src/runtime/locks.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("two acquires on the same agent run one at a time", async () => {
  const locks = new RunLocks();
  const agentId = "00000000-0000-4000-8000-0000000000aa";
  let active = 0;
  let overlap = false;
  const run = async () => {
    const release = await locks.acquire(agentId, 1000);
    active += 1;
    if (active > 1) {
      overlap = true;
    }
    await sleep(30);
    active -= 1;
    release();
  };
  await Promise.all([run(), run()]);
  assert.equal(overlap, false);
});

test("different agents' locks do not block each other", async () => {
  const locks = new RunLocks();
  const first = await locks.acquire("agent-a", 1000);
  const second = await locks.acquire("agent-b", 20);
  assert.equal(locks.isHeld("agent-a") && locks.isHeld("agent-b"), true);
  second();
  first();
  assert.equal(locks.isBusy("agent-a") || locks.isBusy("agent-b"), false);
});

test("a waiter times out with run_busy instead of hanging, and a null timeout waits its turn", async () => {
  const locks = new RunLocks();
  const agentId = "00000000-0000-4000-8000-0000000000cc";
  const release = await locks.acquire(agentId, 1000);
  await assert.rejects(() => locks.acquire(agentId, 20), { statusCode: 503, type: "run_busy" });

  let granted = false;
  const patient = locks.acquire(agentId, null).then((next) => {
    granted = true;
    return next;
  });
  await sleep(40);
  assert.equal(granted, false);
  assert.equal(locks.isBusy(agentId), true);
  release();
  (await patient)();
  assert.equal(granted, true);
  assert.equal(locks.isBusy(agentId), false);
});

test("a queued waiter is busy but not held until the holder releases", async () => {
  const locks = new RunLocks();
  const release = await locks.acquire("agent-q", 1000);
  const queued = locks.acquire("agent-q", 1000);
  assert.equal(locks.isHeld("agent-q"), true);
  release();
  const next = await queued;
  assert.equal(locks.isHeld("agent-q"), true);
  next();
  assert.equal(locks.isHeld("agent-q"), false);
});
