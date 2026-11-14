import assert from "node:assert/strict";
import { test } from "node:test";
import { localParts, routineTitle } from "../src/db/convert-schedules.js";
import { cadenceLabel, nextRunAt } from "../src/runtime/routines.js";

test("the next run is the first matching local time after the given instant", () => {
  const after = new Date(2026, 10, 13, 8, 0, 0);
  assert.deepEqual(nextRunAt("07:00", null, after), new Date(2026, 10, 14, 7, 0, 0));
  assert.deepEqual(nextRunAt("09:30", null, after), new Date(2026, 10, 13, 9, 30, 0));
  assert.deepEqual(nextRunAt("08:00", null, after), new Date(2026, 10, 14, 8, 0, 0), "strictly after");
});

test("a routine on named weekdays skips the others", () => {
  const fridayMorning = new Date(2026, 10, 13, 8, 0, 0);
  assert.equal(fridayMorning.getDay(), 5);
  assert.deepEqual(nextRunAt("13:00", ["sun"], fridayMorning), new Date(2026, 10, 15, 13, 0, 0));
  assert.deepEqual(nextRunAt("13:00", ["mon", "fri"], fridayMorning), new Date(2026, 10, 13, 13, 0, 0));
  assert.deepEqual(nextRunAt("07:30", ["fri"], fridayMorning), new Date(2026, 10, 20, 7, 30, 0));
});

test("a cadence reads as the agent would say it", () => {
  assert.equal(cadenceLabel("07:00", null), "daily 7:00 AM");
  assert.equal(cadenceLabel("21:00", ["mon", "wed"]), "Mon, Wed 9:00 PM");
});

test("a converted routine is titled by the first line of its text, cut at 60 characters", () => {
  assert.equal(routineTitle("Morning due check\nRead D2L and record."), "Morning due check");
  assert.equal(routineTitle("\n\nSecond line"), "Second line");
  assert.equal(routineTitle("x".repeat(80)).length, 60);
  assert.equal(routineTitle("   "), "Routine");
});

test("the local time and weekday of an instant come from the box's zone", () => {
  assert.deepEqual(localParts(new Date("2026-11-15T18:00:00Z"), "America/Detroit"), { time: "13:00", weekday: "sun" });
  assert.deepEqual(localParts(new Date("2026-11-16T04:30:00Z"), "America/Detroit"), { time: "23:30", weekday: "sun" });
  assert.deepEqual(localParts(new Date("2026-07-01T04:00:00Z"), "America/Detroit"), { time: "00:00", weekday: "wed" });
});
