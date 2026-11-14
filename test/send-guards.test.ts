import assert from "node:assert/strict";
import { test } from "node:test";
import { runningRefusal, weekdayRefusal } from "../src/runtime/send.js";

const guard = { weekdayGuard: true };

test("a month and day to Ankur needs a weekday or a relative day beside it", () => {
  for (const content of [
    "Due Wed Nov 18 at 11:59 PM.",
    "Due Wednesday, November 18.",
    "Tonight, Nov 13, nothing is due.",
    "It closed yesterday (Nov 12).",
    "Opens on Mon Dec 7th and closes Fri Dec 11.",
    "Deadline is in 2026, item 12 of 30.",
  ]) {
    assert.equal(weekdayRefusal(guard, null, content), null, content);
  }
  for (const content of ["Due Nov 18 at 11:59 PM.", "Mon Nov 9 is fine but Dec 4 is not.", "See you on May 5th."]) {
    assert.match(weekdayRefusal(guard, null, content) ?? "", /^Not sent: write the weekday/, content);
  }
});

test("the weekday guard leaves agents and a switched-off guard alone", () => {
  assert.equal(weekdayRefusal(guard, "education-specialist", "Due Nov 18."), null);
  assert.equal(weekdayRefusal({ weekdayGuard: false }, null, "Due Nov 18."), null);
});

test("a progress line is refused only while hath sends the pickups", () => {
  assert.match(runningRefusal({ hathPickups: true }, null, "running") ?? "", /hath sends Ankur the pickup/);
  assert.match(runningRefusal({ hathPickups: true }, "cse-300", "running") ?? "", /never a progress line/);
  assert.equal(runningRefusal({ hathPickups: true }, null, "done"), null);
  assert.equal(runningRefusal({ hathPickups: true }, null, undefined), null);
  assert.equal(runningRefusal({ hathPickups: false }, null, "running"), null);
});
