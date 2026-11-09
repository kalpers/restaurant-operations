import {
  addDays,
  localDateOf,
  localMinutesOf,
  localToInstantLenient,
  timeToMinutes,
} from "./zoned-time";

export type BusinessDateSettings = {
  timeZone: string;
  /** "HH:MM" or "HH:MM:SS" local time at which a new operating day begins. */
  businessDayCutoff: string;
};

/**
 * The one authority for restaurant business dates. Before the location's local cutoff, an
 * instant still belongs to the previous operating day: with a 4:00 AM cutoff, Saturday
 * 1:15 AM is Friday. No module may work this out for itself.
 */
export function businessDateOf(
  instant: Date | number,
  settings: BusinessDateSettings,
): string {
  const localDate = localDateOf(instant, settings.timeZone);
  const beforeCutoff =
    localMinutesOf(instant, settings.timeZone) <
    timeToMinutes(settings.businessDayCutoff);

  return beforeCutoff ? addDays(localDate, -1) : localDate;
}

/**
 * The instant a business date begins: its local cutoff time. A cutoff that falls in a
 * spring-forward gap begins at the next moment that exists.
 */
export function businessDateStart(businessDate: string, settings: BusinessDateSettings): Date {
  const candidate = localToInstantLenient(
    businessDate,
    settings.businessDayCutoff,
    settings.timeZone,
  ).getTime();
  // In a gap the wall-clock conversion can land after the jump. Search back (offsets are
  // whole minutes) for the first instant that `businessDateOf` places on this date, so the
  // bounds and `businessDateOf` always agree.
  const minute = 60 * 1000;
  let low = candidate - 3 * 60 * minute;
  let high = candidate;

  while (high - low > minute) {
    const middle = low + Math.floor((high - low) / (2 * minute)) * minute;

    if (businessDateOf(middle, settings) === businessDate) {
      high = middle;
    } else {
      low = middle;
    }
  }

  return new Date(businessDateOf(low, settings) === businessDate ? low : high);
}

/**
 * The half-open instant range `[start, end)` covering the business dates `from` through
 * `to` inclusive. Every instant inside has `businessDateOf` within the range, and every
 * instant outside does not, across DST changes.
 */
export function businessDateRangeBounds(
  from: string,
  to: string,
  settings: BusinessDateSettings,
): { start: Date; end: Date } {
  return {
    start: businessDateStart(from, settings),
    end: businessDateStart(addDays(to, 1), settings),
  };
}
