import assert from "node:assert/strict";
import { test } from "node:test";
import { fillWeekdays } from "../src/runtime/weekdays.js";

const ZONE = "America/Detroit";
/** Mon Nov 9, 2026, noon in Detroit. */
const NOW = new Date("2026-11-09T17:00:00Z");

test("a month and day with no weekday gets its weekday", () => {
  assert.equal(fillWeekdays("HW3 is due Nov 11 at 11:59 PM.", NOW, ZONE), "HW3 is due Wed Nov 11 at 11:59 PM.");
  assert.equal(fillWeekdays("Exam on November 12th.", NOW, ZONE), "Exam on Thu November 12th.");
});

test("a wrong weekday is corrected, a right one is kept", () => {
  assert.equal(fillWeekdays("It closes Mon Nov 11.", NOW, ZONE), "It closes Wed Nov 11.");
  assert.equal(fillWeekdays("It closes Wednesday, Nov 11.", NOW, ZONE), "It closes Wed Nov 11.");
  assert.equal(fillWeekdays("It closes Wed Nov 11.", NOW, ZONE), "It closes Wed Nov 11.");
});

test("a date inside quotes is left as written", () => {
  assert.equal(fillWeekdays('The task "Reading for Monday 11/16" and "Quiz Nov 14" stay; Nov 14 does not.', NOW, ZONE), 'The task "Reading for Monday 11/16" and "Quiz Nov 14" stay; Sat Nov 14 does not.');
});

test("the year is the one that puts the date nearest today, across a year end", () => {
  const lateDecember = new Date("2026-12-30T17:00:00Z");
  assert.equal(fillWeekdays("Back on Jan 4.", lateDecember, ZONE), "Back on Mon Jan 4.");
  assert.equal(fillWeekdays("Since Dec 28.", lateDecember, ZONE), "Since Mon Dec 28.");
});

test("a day that is not on the calendar is left alone, and text with no date is unchanged", () => {
  assert.equal(fillWeekdays("Due Feb 30.", NOW, ZONE), "Due Feb 30.");
  assert.equal(fillWeekdays("Nothing is due tonight.", NOW, ZONE), "Nothing is due tonight.");
});
