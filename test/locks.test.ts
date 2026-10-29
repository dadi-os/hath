import assert from "node:assert/strict";
import { test } from "node:test";
import { LaneLocks } from "../src/runtime/locks.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("two acquires on the same lane run one at a time", async () => {
  const locks = new LaneLocks();
  const agentId = "00000000-0000-4000-8000-0000000000aa";
  let active = 0;
  let overlap = false;
  const run = async () => {
    const release = await locks.acquire(agentId, "process", 1000);
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

test("the work lane and the process lane locks do not block each other", async () => {
  const locks = new LaneLocks();
  const agentId = "00000000-0000-4000-8000-0000000000bb";
  let both = false;
  const workLock = locks.acquire(agentId, "work", 1000).then(async (release) => {
    const processLock = locks.acquire(agentId, "process", 1000);
    const convRelease = await processLock;
    both = locks.isBusy(agentId, "work") && locks.isBusy(agentId, "process");
    convRelease();
    release();
  });
  await workLock;
  assert.equal(both, true);
});

test("a waiter times out instead of hanging", async () => {
  const locks = new LaneLocks();
  const agentId = "00000000-0000-4000-8000-0000000000cc";
  const release = await locks.acquire(agentId, "work", 1000);
  await assert.rejects(() => locks.acquire(agentId, "work", 20), /timed out/);
  release();
});
