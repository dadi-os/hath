/** Local calendar helpers. Weeks start Monday. */

/** Local midnight for `d`. */
export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** Local end-of-day (23:59:59.999) for `d`. */
export function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

/** Add `n` calendar days (local). */
export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** Monday 00:00 of the week containing `d`. */
export function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  const weekday = (day.getDay() + 6) % 7;
  return addDays(day, -weekday);
}

/** First day of the month containing `d`. */
export function startOfMonth(d: Date): Date {
  return startOfDay(new Date(d.getFullYear(), d.getMonth(), 1));
}

/** Last moment of the month containing `d`. */
export function endOfMonth(d: Date): Date {
  return endOfDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/** True when `a` and `b` fall on the same local calendar day. */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** True when `a` and `b` fall in the same local calendar month. */
export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/** Inclusive month grid: weeks from Monday before month start through Sunday after month end. */
export function monthGridDays(anchor: Date): Date[] {
  const first = startOfMonth(anchor);
  const last = endOfMonth(anchor);
  let cursor = startOfWeek(first);
  const end = addDays(startOfWeek(last), 6);
  const days: Date[] = [];
  while (cursor <= end) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** Seven local days Mon–Sun for the week containing `anchor`. */
export function weekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** ISO bounds for Yaad `occurred_from` / `occurred_to` queries. */
export function toIsoBounds(from: Date, to: Date): {
  occurred_from: string;
  occurred_to: string;
} {
  return {
    occurred_from: from.toISOString(),
    occurred_to: to.toISOString(),
  };
}

/** Month title for the calendar header (e.g. "September 2026"). */
export function formatMonthTitle(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(d);
}

/** Week range title spanning month/year boundaries when needed. */
export function formatWeekTitle(d: Date): string {
  const days = weekDays(d);
  const start = days[0]!;
  const end = days[6]!;
  const month = new Intl.DateTimeFormat(undefined, { month: "short" });
  const sameYear = start.getFullYear() === end.getFullYear();
  const sameMonth = sameYear && start.getMonth() === end.getMonth();
  if (sameMonth) {
    return `${month.format(start)} ${start.getDate()}–${end.getDate()}, ${end.getFullYear()}`;
  }
  if (sameYear) {
    return `${month.format(start)} ${start.getDate()} – ${month.format(end)} ${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${month.format(start)} ${start.getDate()}, ${start.getFullYear()} – ${month.format(end)} ${end.getDate()}, ${end.getFullYear()}`;
}

/** Short weekday + day for column headers. */
export function formatDayHeader(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
  }).format(d);
}

/** Local time for an ISO timestamp. */
export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Localized short weekday labels Mon–Sun. */
export function weekdayLabels(): string[] {
  const monday = new Date(2024, 0, 1);
  return Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
      addDays(monday, i),
    ),
  );
}
