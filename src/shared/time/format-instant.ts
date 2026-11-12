// Display formatting for instants in a location's time zone (Phase 20 policy 9). Every
// screen shows times in the location's zone, never the browser's or the server's.

export type InstantStyle = "time" | "date" | "dateTime";

const OPTIONS: Record<InstantStyle, Intl.DateTimeFormatOptions> = {
  time: { hour: "numeric", minute: "2-digit" },
  date: { dateStyle: "medium" },
  dateTime: { dateStyle: "medium", timeStyle: "short" },
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string, style: InstantStyle): Intl.DateTimeFormat {
  const key = `${timeZone}|${style}`;
  let formatter = formatters.get(key);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { ...OPTIONS[style], timeZone });
    formatters.set(key, formatter);
  }

  return formatter;
}

/** "Nov 11, 2026, 5:05 PM" (or the time or date alone) in the location's time zone. */
export function formatInstant(
  value: string | Date | number | null | undefined,
  timeZone: string,
  style: InstantStyle = "dateTime",
): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  return formatterFor(timeZone, style).format(new Date(value));
}

/** An instant as a `datetime-local` value ("2026-11-11T17:05") at the location. */
export function toLocalInputValue(value: string | Date | null | undefined, timeZone: string): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const parts: Record<string, string> = {};

  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(value))) {
    parts[part.type] = part.value;
  }

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
