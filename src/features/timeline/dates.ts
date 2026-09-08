/** Local calendar helpers. Weeks start Monday. */

export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  const weekday = (day.getDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(day, -weekday);
}

export function startOfMonth(d: Date): Date {
  return startOfDay(new Date(d.getFullYear(), d.getMonth(), 1));
}

export function endOfMonth(d: Date): Date {
  return endOfDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

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

export function weekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function toIsoBounds(from: Date, to: Date): {
  occurred_from: string;
  occurred_to: string;
} {
  return {
    occurred_from: from.toISOString(),
    occurred_to: to.toISOString(),
  };
}

export function formatMonthTitle(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(d);
}

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

export function formatDayHeader(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
  }).format(d);
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function weekdayLabels(): string[] {
  const monday = new Date(2024, 0, 1);
  return Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
      addDays(monday, i),
    ),
  );
}
