import assert from "node:assert/strict";
import { test } from "node:test";
import { sweepCaches } from "../src/runtime/retention.js";
import { mockNas } from "./helpers.js";

const DIR = "/var/home/dadi/.dadi";
const NOW = new Date("2026-10-29T12:00:00Z");
const DAY_SECONDS = 24 * 60 * 60;

/** A Nas whose terminal runs the sweep's two commands over an in-memory folder tree: path to mtime in epoch seconds. */
function nasWithFiles(files: Map<string, number>) {
  const nas = mockNas({
    exec: (_id, body) => {
      const list = /^\[ ! -d '([^']+)' \] \|\| find '\1' -maxdepth 1 -type f -printf /.exec(body.command);
      if (list !== null) {
        const folder = list[1]!;
        const lines = [...files]
          .filter(([path]) => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes("/"))
          .map(([path, changed]) => `${changed}.0000000000 ${path}\n`);
        return { exit_code: 0, output: lines.join(""), truncated: false, timed_out: false };
      }
      const remove = /^rm -f -- (.*)$/.exec(body.command);
      assert.ok(remove, `unexpected command: ${body.command}`);
      for (const word of remove[1]!.matchAll(/'([^']*)'/g)) {
        files.delete(word[1]!);
      }
      return { exit_code: 0, output: "", truncated: false, timed_out: false };
    },
  });
  return nas;
}

const secondsAgo = (days: number) => NOW.getTime() / 1000 - days * DAY_SECONDS;

test("the sweep deletes cache files older than the limit and keeps newer ones", async () => {
  const files = new Map<string, number>([
    [`${DIR}/results/old.txt`, secondsAgo(31)],
    [`${DIR}/results/fresh.txt`, secondsAgo(29)],
    [`${DIR}/pdf/old.txt`, secondsAgo(90)],
    [`${DIR}/pdf/fresh.txt`, secondsAgo(1)],
  ]);
  const nas = nasWithFiles(files);

  const removed = await sweepCaches({ nas, dir: DIR }, 30, NOW);

  assert.equal(removed, 2);
  assert.deepEqual([...files.keys()].sort(), [`${DIR}/pdf/fresh.txt`, `${DIR}/results/fresh.txt`]);
  assert.deepEqual(nas.terminalsClosed, ["t1"], "the terminal it opened is closed");
});

test("the sweep never touches attachments, however old", async () => {
  const files = new Map<string, number>([
    [`${DIR}/attachments/abc/cv.pdf`, secondsAgo(900)],
    [`${DIR}/attachments/abc/results/x.txt`, secondsAgo(900)],
    [`${DIR}/notes.txt`, secondsAgo(900)],
    [`${DIR}/results/old.txt`, secondsAgo(900)],
  ]);
  const nas = nasWithFiles(files);

  await sweepCaches({ nas, dir: DIR }, 30, NOW);

  assert.deepEqual([...files.keys()].sort(), [`${DIR}/attachments/abc/cv.pdf`, `${DIR}/attachments/abc/results/x.txt`, `${DIR}/notes.txt`]);
  for (const call of nas.execCalls) {
    assert.doesNotMatch(call.body.command, /attachments/);
  }
});

test("the sweep with nothing expired runs no removal", async () => {
  const files = new Map<string, number>([[`${DIR}/results/fresh.txt`, secondsAgo(2)]]);
  const nas = nasWithFiles(files);

  assert.equal(await sweepCaches({ nas, dir: DIR }, 30, NOW), 0);

  assert.equal(nas.execCalls.some((call) => call.body.command.startsWith("rm")), false);
});

test("a failed listing fails the sweep loudly and still closes the terminal", async () => {
  const nas = mockNas({ exec: () => ({ exit_code: 2, output: "find: boom", truncated: false, timed_out: false }) });

  await assert.rejects(() => sweepCaches({ nas, dir: DIR }, 30, NOW), /listing .* failed/);

  assert.deepEqual(nas.terminalsClosed, ["t1"]);
});

test("a listing cut short drops its last, possibly partial, line", async () => {
  const removed: string[] = [];
  const nas = mockNas({
    exec: (_id, body) => {
      if (body.command.startsWith("rm")) {
        removed.push(body.command);
        return { exit_code: 0, output: "", truncated: false, timed_out: false };
      }
      return body.command.includes("/results")
        ? { exit_code: 0, output: `1.0 ${DIR}/results/a.txt\n1.0 ${DIR}/results/b`, truncated: true, timed_out: false }
        : { exit_code: 0, output: "", truncated: false, timed_out: false };
    },
  });

  assert.equal(await sweepCaches({ nas, dir: DIR }, 30, NOW), 1);

  assert.equal(removed.length, 1);
  assert.match(removed[0]!, /a\.txt/);
  assert.doesNotMatch(removed[0]!, /results\/b'/);
});
