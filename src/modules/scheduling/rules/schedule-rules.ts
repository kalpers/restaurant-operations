import {
  addDays,
  dayOfWeek,
  localDateOf,
  localMinutesOf,
} from "@/shared/time/zoned-time";

import { hoursToMs } from "../types";

/** Scheduling rules in the exact units the decisions use. */
export type SchedulingRuleSet = {
  avoidOvertime: boolean;
  overtimeThresholdMs: number;
  minimumRestMs: number | null;
  minimumRestHard: boolean;
  maximumDaysPerWeek: number | null;
  maximumDaysHard: boolean;
  maximumConsecutiveDays: number | null;
  maximumConsecutiveHard: boolean;
  maximumWeeklyMs: number | null;
  balanceWeekendShifts: boolean;
  balanceClosingShifts: boolean;
  preferTargetHours: boolean;
  weekStartDay: number;
};

export type SchedulingRuleRow = {
  avoidOvertime: boolean;
  weeklyOvertimeThreshold: string;
  minimumRestHours: string | null;
  minimumRestHard: boolean;
  maximumDaysPerWeek: number | null;
  maximumDaysHard: boolean;
  maximumConsecutiveDays: number | null;
  maximumConsecutiveHard: boolean;
  maximumWeeklyHours: string | null;
  balanceWeekendShifts: boolean;
  balanceClosingShifts: boolean;
  preferTargetHours: boolean;
  weekStartDay: number;
  /** Phase 18 time clock settings. Not used by scheduling decisions. */
  overtimeMultiplier: string;
  lateClockInGraceMinutes: number;
  /** Phase 20 (policy 19): daily overtime threshold in hours, or null when off. */
  dailyOvertimeThreshold: string | null;
};

/** Used for a location that has no rules row yet. Matches the seeded defaults. */
export const DEFAULT_RULE_ROW: SchedulingRuleRow = {
  avoidOvertime: true,
  weeklyOvertimeThreshold: "40.00",
  minimumRestHours: "8.00",
  minimumRestHard: false,
  maximumDaysPerWeek: null,
  maximumDaysHard: false,
  maximumConsecutiveDays: null,
  maximumConsecutiveHard: false,
  maximumWeeklyHours: null,
  balanceWeekendShifts: true,
  balanceClosingShifts: true,
  preferTargetHours: true,
  weekStartDay: 1,
  overtimeMultiplier: "1.50",
  lateClockInGraceMinutes: 5,
  dailyOvertimeThreshold: null,
};

export function toRuleSet(row: SchedulingRuleRow): SchedulingRuleSet {
  return {
    avoidOvertime: row.avoidOvertime,
    overtimeThresholdMs: hoursToMs(row.weeklyOvertimeThreshold),
    minimumRestMs:
      row.minimumRestHours === null ? null : hoursToMs(row.minimumRestHours),
    minimumRestHard: row.minimumRestHard,
    maximumDaysPerWeek: row.maximumDaysPerWeek,
    maximumDaysHard: row.maximumDaysHard,
    maximumConsecutiveDays: row.maximumConsecutiveDays,
    maximumConsecutiveHard: row.maximumConsecutiveHard,
    maximumWeeklyMs:
      row.maximumWeeklyHours === null ? null : hoursToMs(row.maximumWeeklyHours),
    balanceWeekendShifts: row.balanceWeekendShifts,
    balanceClosingShifts: row.balanceClosingShifts,
    preferTargetHours: row.preferTargetHours,
    weekStartDay: row.weekStartDay,
  };
}

export type ScheduledShift = {
  shiftId: string;
  periodId: string;
  shiftDate: string;
  startAt: Date;
  endAt: Date;
};

/** Starting before this local time is an opening shift. */
const OPENING_BEFORE_MINUTES = 11 * 60;
/** Ending at or after this local time, or past midnight, is a closing shift. */
const CLOSING_FROM_MINUTES = 22 * 60;

/** Saturday or Sunday by `shift_date`, the worked day for all counting. */
export function isWeekendShift(shiftDate: string): boolean {
  const day = dayOfWeek(shiftDate);

  return day === 0 || day === 6;
}

export function isOpeningShift(startAt: Date, timeZone: string): boolean {
  return localMinutesOf(startAt, timeZone) < OPENING_BEFORE_MINUTES;
}

export function isClosingShift(
  shift: { shiftDate: string; endAt: Date },
  timeZone: string,
): boolean {
  return (
    localDateOf(Number(shift.endAt) - 1, timeZone) !== shift.shiftDate ||
    localMinutesOf(shift.endAt, timeZone) >= CLOSING_FROM_MINUTES
  );
}

/** The first date of the scheduling week containing `date`. */
export function weekStartOf(date: string, weekStartDay: number): string {
  return addDays(date, -((dayOfWeek(date) - weekStartDay + 7) % 7));
}

function durationMs(shift: { startAt: Date; endAt: Date }): number {
  return Number(shift.endAt) - Number(shift.startAt);
}

/**
 * What the employee's week looks like if they also work `shift`. Every shift counts on
 * its `shift_date`, including one that runs past midnight.
 */
export function projectWeek(
  shift: { shiftDate: string; startAt: Date; endAt: Date },
  others: readonly ScheduledShift[],
  rules: Pick<SchedulingRuleSet, "weekStartDay">,
) {
  const weekStart = weekStartOf(shift.shiftDate, rules.weekStartDay);
  const weekEnd = addDays(weekStart, 6);
  const sameWeek = others.filter(
    (other) => other.shiftDate >= weekStart && other.shiftDate <= weekEnd,
  );
  const currentMs = sameWeek.reduce(
    (total, other) => total + durationMs(other),
    0,
  );
  const allDates = new Set(others.map((other) => other.shiftDate));

  allDates.add(shift.shiftDate);

  let consecutiveDays = 1;

  for (
    let date = addDays(shift.shiftDate, -1);
    allDates.has(date);
    date = addDays(date, -1)
  ) {
    consecutiveDays += 1;
  }

  for (
    let date = addDays(shift.shiftDate, 1);
    allDates.has(date);
    date = addDays(date, 1)
  ) {
    consecutiveDays += 1;
  }

  return {
    currentMs,
    projectedMs: currentMs + durationMs(shift),
    days: new Set([...sameWeek.map((other) => other.shiftDate), shift.shiftDate])
      .size,
    consecutiveDays,
  };
}

/** The shortest gap to any other shift that doesn't overlap this one, or null. */
export function shortestRestMs(
  shift: { startAt: Date; endAt: Date },
  others: readonly ScheduledShift[],
): number | null {
  let shortest: number | null = null;

  for (const other of others) {
    const gap =
      Number(other.endAt) <= Number(shift.startAt)
        ? Number(shift.startAt) - Number(other.endAt)
        : Number(shift.endAt) <= Number(other.startAt)
          ? Number(other.startAt) - Number(shift.endAt)
          : null;

    if (gap !== null && (shortest === null || gap < shortest)) {
      shortest = gap;
    }
  }

  return shortest;
}
