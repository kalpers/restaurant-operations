import {
  addDays,
  dayOfWeek,
  localDateOf,
  localToInstantLenient,
  timeToMinutes,
} from "@/shared/time/zoned-time";

import type { AvailabilityType } from "../types";
import { overlaps, subtract, type Interval } from "./intervals";

export type RecurringAvailability = {
  locationId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  availabilityType: AvailabilityType;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type AvailabilityException = {
  locationId: string | null;
  exceptionDate: string;
  startTime: string | null;
  endTime: string | null;
  availabilityType: AvailabilityType;
};

export type AvailabilityResult =
  | "AVAILABLE"
  | "AVAILABILITY_UNAVAILABLE"
  | "AVAILABILITY_NOT_COVERED"
  | "AVAILABILITY_NOT_CONFIGURED";

type TypedWindow = { type: AvailabilityType; interval: Interval };

function windowOn(
  date: string,
  startTime: string,
  endTime: string,
  timeZone: string,
): { interval: Interval; overnight: boolean } {
  const overnight = timeToMinutes(endTime) <= timeToMinutes(startTime);

  return {
    overnight,
    interval: {
      start: Number(localToInstantLenient(date, startTime, timeZone)),
      end: Number(
        localToInstantLenient(
          overnight ? addDays(date, 1) : date,
          endTime,
          timeZone,
        ),
      ),
    },
  };
}

function hasUnavailableOverlap(
  windows: readonly TypedWindow[],
  parts: readonly Interval[],
): boolean {
  return windows.some(
    (window) =>
      window.type === "UNAVAILABLE" &&
      parts.some((part) => overlaps(window.interval, part)),
  );
}

/**
 * The one availability rule, used by manual assignment, generation, Fill Open Shifts,
 * swap acceptance and publishing. There is no override: fix the data instead.
 *
 * A shift needs AVAILABLE covering every minute. Exceptions decide the time they cover,
 * and recurring availability must cover the rest. Any UNAVAILABLE that applies to the
 * shift's uncovered time rules the employee out. A missing record never counts as
 * available: nothing applying to the shift's dates is AVAILABILITY_NOT_CONFIGURED,
 * which stays distinct from an explicit UNAVAILABLE and from partial coverage.
 */
export function evaluateAvailability(input: {
  shift: { shiftDate: string; startAt: Date; endAt: Date; locationId: string };
  recurring: readonly RecurringAvailability[];
  exceptions: readonly AvailabilityException[];
  timeZone: string;
}): AvailabilityResult {
  const { shift, timeZone } = input;
  const shiftInterval: Interval = {
    start: Number(shift.startAt),
    end: Number(shift.endAt),
  };
  const appliesHere = (record: { locationId: string | null }) =>
    record.locationId === null || record.locationId === shift.locationId;

  // The last date the shift touches. Its end is exclusive, so midnight doesn't count.
  const lastDate = localDateOf(shiftInterval.end - 1, timeZone);
  const priorDate = addDays(shift.shiftDate, -1);
  const dates: string[] = [];

  for (let date = priorDate; date <= lastDate; date = addDays(date, 1)) {
    dates.push(date);
  }

  let applicable = false;
  const exceptionWindows: TypedWindow[] = [];

  for (const exception of input.exceptions.filter(appliesHere)) {
    const date = exception.exceptionDate;

    if (!dates.includes(date)) {
      continue;
    }

    if (exception.startTime === null || exception.endTime === null) {
      // A whole-date exception on the prior day ends at midnight, before the shift's date.
      if (date !== priorDate) {
        applicable = true;
        exceptionWindows.push({
          type: exception.availabilityType,
          interval: {
            start: Number(localToInstantLenient(date, "00:00", timeZone)),
            end: Number(
              localToInstantLenient(addDays(date, 1), "00:00", timeZone),
            ),
          },
        });
      }

      continue;
    }

    const { interval, overnight } = windowOn(
      date,
      exception.startTime,
      exception.endTime,
      timeZone,
    );

    if (date !== priorDate || overnight) {
      applicable = true;
      exceptionWindows.push({ type: exception.availabilityType, interval });
    }
  }

  if (hasUnavailableOverlap(exceptionWindows, [shiftInterval])) {
    return "AVAILABILITY_UNAVAILABLE";
  }

  let remaining: Interval[] = [shiftInterval];

  for (const window of exceptionWindows) {
    remaining = subtract(remaining, window.interval);
  }

  const recurringWindows: TypedWindow[] = [];

  for (const record of input.recurring.filter(appliesHere)) {
    for (const date of dates) {
      if (
        dayOfWeek(date) !== record.dayOfWeek ||
        date < record.effectiveFrom ||
        (record.effectiveTo !== null && date > record.effectiveTo)
      ) {
        continue;
      }

      const { interval, overnight } = windowOn(
        date,
        record.startTime,
        record.endTime,
        timeZone,
      );

      if (date !== priorDate || overnight) {
        applicable = true;
        recurringWindows.push({ type: record.availabilityType, interval });
      }
    }
  }

  if (hasUnavailableOverlap(recurringWindows, remaining)) {
    return "AVAILABILITY_UNAVAILABLE";
  }

  for (const window of recurringWindows) {
    remaining = subtract(remaining, window.interval);
  }

  if (remaining.length === 0) {
    return "AVAILABLE";
  }

  return applicable ? "AVAILABILITY_NOT_COVERED" : "AVAILABILITY_NOT_CONFIGURED";
}
