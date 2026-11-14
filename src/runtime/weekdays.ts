/**
 * Weekday fill: every month and day in a message to Ankur gets its weekday beside it, computed
 * in the box's time zone for the year nearest the message's date, and a wrong weekday is
 * corrected. Text in quotes is left as it is.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MONTH_PATTERN = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

/** A month and day with an optional weekday before it, as "Mon Nov 11", "Nov 11" or "Monday, November 11th". */
const DATE = new RegExp(
  `(?:\\b(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)(?:day|sday|nesday|urday)?,? )?\\b(${MONTH_PATTERN})\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`,
  "g",
);

/** Spans of `text` inside double quotes, which fill leaves alone. */
function quotedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of text.matchAll(/"[^"\n]*"|“[^”\n]*”/g)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

/** localDateParts is the year, month (0-11) and day of `at` in `timeZone`. */
function localDateParts(at: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(at);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)!.value);
  return { year: part("year"), month: part("month") - 1, day: part("day") };
}

/** weekdayOf is the weekday of the calendar date year-month-day, which is the same date in every zone. */
function weekdayOf(year: number, month: number, day: number): string {
  return WEEKDAY_NAMES[new Date(Date.UTC(year, month, day)).getUTCDay()]!;
}

/**
 * fillWeekdays is `content` with its weekday written beside every month and day outside quotes:
 * in the year, from the one before `now` to the one after, in which that date falls nearest to
 * `now`'s local date. A date that has a weekday before it gets that weekday replaced by the
 * right one; a date that is not a real calendar date is left as written.
 */
export function fillWeekdays(content: string, now: Date, timeZone: string): string {
  const today = localDateParts(now, timeZone);
  const todayMs = Date.UTC(today.year, today.month, today.day);
  const quoted = quotedSpans(content);
  return content.replace(DATE, (whole, _given: string | undefined, monthName: string, dayText: string, offset: number) => {
    if (quoted.some(([start, end]) => offset >= start && offset < end)) {
      return whole;
    }
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);
    const day = Number(dayText);
    const candidates = [today.year - 1, today.year, today.year + 1].filter((year) => new Date(Date.UTC(year, month, day)).getUTCMonth() === month);
    if (candidates.length === 0) {
      return whole;
    }
    const year = candidates.reduce((best, candidate) =>
      Math.abs(Date.UTC(candidate, month, day) - todayMs) < Math.abs(Date.UTC(best, month, day) - todayMs) ? candidate : best,
    );
    const date = whole.replace(/^(?:(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)(?:day|sday|nesday|urday)?,? )/, "");
    return `${weekdayOf(year, month, day)} ${date}`;
  });
}
