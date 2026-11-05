// Local wall-clock times at a location, converted through the IANA time-zone database.
// These are calendar dates and clock times, not restaurant business dates.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }

  return formatter;
}

type LocalParts = {
  date: string;
  hour: number;
  minute: number;
  second: number;
};

function localPartsOf(instant: number, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};

  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    parts[part.type] = part.value;
  }

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The local calendar date of an instant. This is not a business date. */
export function localDateOf(instant: Date | number, timeZone: string): string {
  return localPartsOf(Number(instant), timeZone).date;
}

/** Minutes after local midnight, by the clock. */
export function localMinutesOf(instant: Date | number, timeZone: string): number {
  const { hour, minute } = localPartsOf(Number(instant), timeZone);

  return hour * 60 + minute;
}

/** "HH:MM" in the location's time zone, for display. */
export function localTimeOf(instant: Date | number, timeZone: string): string {
  const { hour, minute } = localPartsOf(Number(instant), timeZone);

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Works in UTC, so a daylight-saving change can't shift the result. */
export function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00.000Z`);

  instant.setUTCDate(instant.getUTCDate() + days);

  return instant.toISOString().slice(0, 10);
}

/** 0 is Sunday. */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

/** "17:30" or "17:30:00" as minutes after midnight. */
export function timeToMinutes(time: string): number {
  const [hour = "0", minute = "0"] = time.split(":");

  return Number(hour) * 60 + Number(minute);
}

function wallClockAsUtc(date: string, time: string): number {
  const seconds = time.length === 5 ? `${time}:00` : time;

  return Date.parse(`${date}T${seconds}.000Z`);
}

function offsetAt(instant: number, timeZone: string): number {
  const { date, hour, minute, second } = localPartsOf(instant, timeZone);
  const wholeSecond = Math.floor(instant / 1000) * 1000;

  return (
    Date.parse(`${date}T00:00:00.000Z`) +
    (hour * 3600 + minute * 60 + second) * 1000 -
    wholeSecond
  );
}

/**
 * The instant of a local date and time, or null if that time doesn't exist because the
 * clocks jumped forward. A time that happens twice resolves to the earlier one.
 */
export function localToInstant(
  date: string,
  time: string,
  timeZone: string,
): Date | null {
  const wallClock = wallClockAsUtc(date, time);
  const dayMs = 24 * 60 * 60 * 1000;
  const offsets = new Set([
    offsetAt(wallClock - dayMs, timeZone),
    offsetAt(wallClock + dayMs, timeZone),
  ]);
  const matches = [...offsets]
    .map((offset) => wallClock - offset)
    .filter((candidate) => offsetAt(candidate, timeZone) === wallClock - candidate)
    .sort((left, right) => left - right);
  const [earliest] = matches;

  return earliest === undefined ? null : new Date(earliest);
}

/**
 * For availability windows, where a nonexistent time simply means the next moment that
 * exists: a window opening at 02:30 on a spring-forward night opens when the clock jumps.
 */
export function localToInstantLenient(
  date: string,
  time: string,
  timeZone: string,
): Date {
  const exact = localToInstant(date, time, timeZone);

  if (exact) {
    return exact;
  }

  const wallClock = wallClockAsUtc(date, time);
  const before = offsetAt(wallClock - 24 * 60 * 60 * 1000, timeZone);

  return new Date(wallClock - before);
}
