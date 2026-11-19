import {
  addDays,
  dayOfWeek,
  localDateOf,
  localMinutesOf,
  localToInstantLenient,
  timeToMinutes,
} from "@/shared/time/zoned-time";

// Phase 28 price periods (policies 2, 3 and 5). Pure and deterministic. A period is local
// wall-clock days and times at one location: it applies when the local clock at the instant
// is inside [start, end) on one of its days. An end at or before the start crosses midnight,
// and that stretch belongs to the day it started, so "Fri 22:00-01:00" covers Saturday 00:30.
// Comparing local clock times makes daylight-saving days behave as the clock on the wall does.

export type OrderTypeCode = "DINE_IN" | "BAR" | "TAKEOUT";

export type PricePeriodRule = {
  id: string;
  name: string;
  /** 0 Sunday to 6 Saturday: the local days the period starts on. */
  daysOfWeek: readonly number[];
  /** "HH:MM" or "HH:MM:SS", local. */
  startTime: string;
  endTime: string;
  /** Null: every order type. */
  orderTypes: readonly string[] | null;
  /** Inclusive local dates of the start day, or null. */
  firstDate: string | null;
  lastDate: string | null;
  active: boolean;
};

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

function crossesMidnight(period: PricePeriodRule): boolean {
  return timeToMinutes(period.endTime) <= timeToMinutes(period.startTime);
}

function startDayAllowed(period: PricePeriodRule, date: string): boolean {
  return (
    period.daysOfWeek.includes(dayOfWeek(date)) &&
    (period.firstDate === null || date >= period.firstDate) &&
    (period.lastDate === null || date <= period.lastDate)
  );
}

function orderTypeAllowed(period: PricePeriodRule, orderType: string | null): boolean {
  if (period.orderTypes === null) {
    return true;
  }

  // Without an order type (a general menu view) only all-order-type periods apply.
  return orderType !== null && period.orderTypes.includes(orderType);
}

export type PeriodOccurrence = {
  /** Local date the occurrence started on. */
  startDate: string;
  /** The instant it ends. */
  endsAt: Date;
};

/**
 * The occurrence of a period in effect at an instant, or null. Inactive periods never apply.
 */
export function periodOccurrenceAt(
  period: PricePeriodRule,
  at: Date,
  timeZone: string,
  orderType: string | null,
): PeriodOccurrence | null {
  if (!period.active || !orderTypeAllowed(period, orderType)) {
    return null;
  }

  const today = localDateOf(at, timeZone);
  const minutes = localMinutesOf(at, timeZone);
  const start = timeToMinutes(period.startTime);
  const end = timeToMinutes(period.endTime);

  if (!crossesMidnight(period)) {
    if (startDayAllowed(period, today) && minutes >= start && minutes < end) {
      return { startDate: today, endsAt: localToInstantLenient(today, period.endTime, timeZone) };
    }

    return null;
  }

  if (startDayAllowed(period, today) && minutes >= start) {
    return {
      startDate: today,
      endsAt: localToInstantLenient(addDays(today, 1), period.endTime, timeZone),
    };
  }

  const yesterday = addDays(today, -1);

  if (startDayAllowed(period, yesterday) && minutes < end) {
    return { startDate: yesterday, endsAt: localToInstantLenient(today, period.endTime, timeZone) };
  }

  return null;
}

/** Minute-of-week intervals [from, to) a period covers, crossing midnight split at the week end. */
function weeklyIntervals(period: PricePeriodRule): [number, number][] {
  const start = timeToMinutes(period.startTime);
  const end = timeToMinutes(period.endTime);
  const length = end > start ? end - start : DAY_MINUTES - start + end;
  const intervals: [number, number][] = [];

  for (const day of new Set(period.daysOfWeek)) {
    const from = day * DAY_MINUTES + start;
    const to = from + length;

    if (to <= WEEK_MINUTES) {
      intervals.push([from, to]);
    } else {
      intervals.push([from, WEEK_MINUTES], [0, to - WEEK_MINUTES]);
    }
  }

  return intervals;
}

function datesIntersect(a: PricePeriodRule, b: PricePeriodRule): boolean {
  // A crossing period's last occurrence spills one day past its last date.
  const aTo = a.lastDate === null ? null : crossesMidnight(a) ? addDays(a.lastDate, 1) : a.lastDate;
  const bTo = b.lastDate === null ? null : crossesMidnight(b) ? addDays(b.lastDate, 1) : b.lastDate;
  const aFromBeforeBTo = bTo === null || a.firstDate === null || a.firstDate <= bTo;
  const bFromBeforeATo = aTo === null || b.firstDate === null || b.firstDate <= aTo;

  return aFromBeforeBTo && bFromBeforeATo;
}

function orderTypesIntersect(a: PricePeriodRule, b: PricePeriodRule): boolean {
  if (a.orderTypes === null || b.orderTypes === null) {
    return true;
  }

  return a.orderTypes.some((type) => b.orderTypes?.includes(type));
}

/**
 * Policy 3: whether two periods could both apply at one instant for one order type. Date
 * ranges are compared as ranges, so two short ranges on different weekdays may be refused
 * even if their days never meet; managers split such periods by date instead.
 */
export function periodsOverlap(a: PricePeriodRule, b: PricePeriodRule): boolean {
  if (!a.active || !b.active || !orderTypesIntersect(a, b) || !datesIntersect(a, b)) {
    return false;
  }

  const left = weeklyIntervals(a);
  const right = weeklyIntervals(b);

  return left.some(([aFrom, aTo]) => right.some(([bFrom, bTo]) => aFrom < bTo && bFrom < aTo));
}

export type PeriodPrice = {
  period: PricePeriodRule;
  price: string;
  occurrence: PeriodOccurrence;
};

/**
 * The period price for one item at an instant: the one active period that applies and
 * prices the item. Overlaps are refused when saving, so at most one applies; if data ever
 * disagrees, the earliest-starting, then lowest ID, wins so the answer stays deterministic.
 */
export function periodPriceAt(
  periods: readonly PricePeriodRule[],
  itemPrices: ReadonlyMap<string, string>,
  at: Date,
  timeZone: string,
  orderType: string | null,
): PeriodPrice | null {
  const matches: PeriodPrice[] = [];

  for (const period of periods) {
    const price = itemPrices.get(period.id);

    if (price === undefined) {
      continue;
    }

    const occurrence = periodOccurrenceAt(period, at, timeZone, orderType);

    if (occurrence) {
      matches.push({ period, price, occurrence });
    }
  }

  matches.sort(
    (left, right) =>
      timeToMinutes(left.period.startTime) - timeToMinutes(right.period.startTime) ||
      left.period.id.localeCompare(right.period.id),
  );

  return matches[0] ?? null;
}
