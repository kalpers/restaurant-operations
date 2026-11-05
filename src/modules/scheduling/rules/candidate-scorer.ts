import { localMinutesOf, timeToMinutes } from "@/shared/time/zoned-time";

import { msToHours } from "../types";
import type {
  EligibilityShift,
  EmployeeFacts,
  EmployeeScheduleContext,
} from "./eligibility";
import { overlaps } from "./intervals";
import {
  isClosingShift,
  isOpeningShift,
  isWeekendShift,
  projectWeek,
  shortestRestMs,
  type SchedulingRuleSet,
} from "./schedule-rules";
import { SCORING_WEIGHTS } from "./scoring-weights";

export type ScoreReason = { code: string; points: number; detail: string };

export type SoftWarning = { code: string; message: string };

type SoftInput = {
  shift: EligibilityShift;
  context: EmployeeScheduleContext;
  rules: SchedulingRuleSet;
};

/** Soft limits come from the employee's preference, then any non-hard location rule. */
function softDayLimits({ context, rules }: Pick<SoftInput, "context" | "rules">) {
  return {
    days:
      context.preferences?.maximumDaysPerWeek ??
      (rules.maximumDaysHard ? null : rules.maximumDaysPerWeek),
    consecutive:
      context.preferences?.maximumConsecutiveDays ??
      (rules.maximumConsecutiveHard ? null : rules.maximumConsecutiveDays),
  };
}

function hasPendingTimeOff({ shift, context }: SoftInput): boolean {
  return context.pendingTimeOff.some((span) =>
    overlaps(
      { start: Number(span.startAt), end: Number(span.endAt) },
      { start: Number(shift.startAt), end: Number(shift.endAt) },
    ),
  );
}

function shortRestMs({ shift, context, rules }: SoftInput): number | null {
  if (rules.minimumRestHard || rules.minimumRestMs === null) {
    return null;
  }

  const rest = shortestRestMs(shift, context.assignments);

  return rest !== null && rest < rules.minimumRestMs ? rest : null;
}

/** Things a manager should know. They never block an assignment. */
export function softWarningsFor(input: SoftInput): SoftWarning[] {
  const { shift, context, rules } = input;
  const week = projectWeek(shift, context.assignments, rules);
  const limits = softDayLimits(input);
  const warnings: SoftWarning[] = [];

  if (hasPendingTimeOff(input)) {
    warnings.push({
      code: "PENDING_TIME_OFF",
      message: "The employee has a pending time-off request during this shift.",
    });
  }

  if (rules.avoidOvertime && week.projectedMs > rules.overtimeThresholdMs) {
    warnings.push({
      code: "PROJECTED_OVERTIME",
      message: `This brings the week to ${msToHours(week.projectedMs)} hours, past the ${msToHours(rules.overtimeThresholdMs)} hour overtime threshold.`,
    });
  }

  const rest = shortRestMs(input);

  if (rest !== null) {
    warnings.push({
      code: "SHORT_REST",
      message: `This leaves only ${msToHours(rest)} hours of rest next to another shift.`,
    });
  }

  if (limits.days !== null && week.days > limits.days) {
    warnings.push({
      code: "WEEKLY_DAYS_PREFERENCE",
      message: `This makes ${week.days} days in the week, past the preferred ${limits.days}.`,
    });
  }

  if (limits.consecutive !== null && week.consecutiveDays > limits.consecutive) {
    warnings.push({
      code: "CONSECUTIVE_DAYS_PREFERENCE",
      message: `This makes ${week.consecutiveDays} days in a row, past the preferred ${limits.consecutive}.`,
    });
  }

  return warnings;
}

export type FairnessCounts = { weekend: number; closing: number };

/** How many weekend and closing shifts an employee has in the lookback (the period). */
export function fairnessCountsFor(
  context: EmployeeScheduleContext,
  periodId: string,
  timeZone: string,
): FairnessCounts {
  const inPeriod = context.assignments.filter(
    (assignment) => assignment.periodId === periodId,
  );

  return {
    weekend: inPeriod.filter((shift) => isWeekendShift(shift.shiftDate)).length,
    closing: inPeriod.filter((shift) => isClosingShift(shift, timeZone)).length,
  };
}

function preferenceReasons(
  shift: EligibilityShift,
  context: EmployeeScheduleContext,
  timeZone: string,
): ScoreReason[] {
  const preferences = context.preferences;

  if (!preferences) {
    return [];
  }

  const reasons: ScoreReason[] = [];
  const stated = (
    preference: boolean | null,
    applies: boolean,
    code: string,
    name: string,
  ) => {
    if (preference !== null && applies) {
      reasons.push(
        preference
          ? {
              code,
              points: SCORING_WEIGHTS.preferredTimeMatch,
              detail: `Prefers ${name} shifts`,
            }
          : {
              code,
              points: SCORING_WEIGHTS.preferredTimeMismatch,
              detail: `Prefers not to work ${name} shifts`,
            },
      );
    }
  };

  if (preferences.preferredShiftStart && preferences.preferredShiftEnd) {
    const windowStart = timeToMinutes(preferences.preferredShiftStart);
    const windowEnd = timeToMinutes(preferences.preferredShiftEnd);
    const start = localMinutesOf(shift.startAt, timeZone);
    const inWindow =
      windowStart <= windowEnd
        ? start >= windowStart && start < windowEnd
        : start >= windowStart || start < windowEnd;

    reasons.push(
      inWindow
        ? {
            code: "PREFERRED_TIME",
            points: SCORING_WEIGHTS.preferredTimeMatch,
            detail: "Starts in the preferred time window",
          }
        : {
            code: "PREFERRED_TIME",
            points: SCORING_WEIGHTS.preferredTimeMismatch,
            detail: "Starts outside the preferred time window",
          },
    );
  }

  stated(
    preferences.preferWeekends,
    isWeekendShift(shift.shiftDate),
    "PREFERS_WEEKENDS",
    "weekend",
  );
  stated(
    preferences.preferOpening,
    isOpeningShift(shift.startAt, timeZone),
    "PREFERS_OPENING",
    "opening",
  );
  stated(
    preferences.preferClosing,
    isClosingShift(shift, timeZone),
    "PREFERS_CLOSING",
    "closing",
  );

  return reasons;
}

/**
 * The deterministic score of an eligible candidate. It reads scheduling data only:
 * compensation isn't an input, so pay can never influence the ranking.
 * `highestCounts` are the largest fairness counts among the candidates being compared.
 */
export function scoreCandidate(input: {
  shift: EligibilityShift;
  employee: EmployeeFacts;
  context: EmployeeScheduleContext;
  rules: SchedulingRuleSet;
  timeZone: string;
  counts: FairnessCounts;
  highestCounts: FairnessCounts;
}): { score: number; reasons: ScoreReason[] } {
  const { shift, context, rules, timeZone, counts, highestCounts } = input;
  const week = projectWeek(shift, context.assignments, rules);
  const limits = softDayLimits({ context, rules });
  const reasons: ScoreReason[] = [];
  const targetMs = context.preferences?.targetMs ?? null;

  if (rules.preferTargetHours && targetMs !== null) {
    reasons.push(
      week.currentMs < targetMs
        ? {
            code: "BELOW_TARGET_HOURS",
            points: SCORING_WEIGHTS.belowTargetHours,
            detail: `Below target weekly hours (${msToHours(week.currentMs)} of ${msToHours(targetMs)})`,
          }
        : {
            code: "AT_OR_ABOVE_TARGET_HOURS",
            points: SCORING_WEIGHTS.atOrAboveTargetHours,
            detail: `At or above target weekly hours (${msToHours(week.currentMs)} of ${msToHours(targetMs)})`,
          },
    );
  }

  if (rules.avoidOvertime && week.projectedMs > rules.overtimeThresholdMs) {
    reasons.push({
      code: "CROSSES_OVERTIME",
      points: SCORING_WEIGHTS.crossesOvertimeThreshold,
      detail: `Would reach ${msToHours(week.projectedMs)} hours, past the overtime threshold`,
    });
  }

  reasons.push(...preferenceReasons(shift, context, timeZone));

  const weekendGap = highestCounts.weekend - counts.weekend;

  if (rules.balanceWeekendShifts && isWeekendShift(shift.shiftDate) && weekendGap > 0) {
    reasons.push({
      code: "WEEKEND_FAIRNESS",
      points: SCORING_WEIGHTS.fairnessPerShift * weekendGap,
      detail: `${weekendGap} fewer weekend shifts than the most loaded candidate`,
    });
  }

  const closingGap = highestCounts.closing - counts.closing;

  if (rules.balanceClosingShifts && isClosingShift(shift, timeZone) && closingGap > 0) {
    reasons.push({
      code: "CLOSING_FAIRNESS",
      points: SCORING_WEIGHTS.fairnessPerShift * closingGap,
      detail: `${closingGap} fewer closing shifts than the most loaded candidate`,
    });
  }

  const rest = shortRestMs({ shift, context, rules });

  if (rest !== null) {
    reasons.push({
      code: "SHORT_REST",
      points: SCORING_WEIGHTS.shortRest,
      detail: `Creates only ${msToHours(rest)} hours of rest next to another shift`,
    });
  }

  if (hasPendingTimeOff({ shift, context, rules })) {
    reasons.push({
      code: "PENDING_TIME_OFF",
      points: SCORING_WEIGHTS.pendingTimeOffOverlap,
      detail: "Has a pending time-off request during this shift",
    });
  }

  if (limits.days !== null && week.days > limits.days) {
    const excess = week.days - limits.days;

    reasons.push({
      code: "WEEKLY_DAYS_PREFERENCE",
      points: SCORING_WEIGHTS.softWeeklyDayExcessPerDay * excess,
      detail: `${excess} days past the preferred days per week`,
    });
  }

  if (limits.consecutive !== null && week.consecutiveDays > limits.consecutive) {
    const excess = week.consecutiveDays - limits.consecutive;

    reasons.push({
      code: "CONSECUTIVE_DAYS_PREFERENCE",
      points: SCORING_WEIGHTS.softConsecutiveDayExcessPerDay * excess,
      detail: `${excess} days past the preferred consecutive days`,
    });
  }

  return {
    score: reasons.reduce((total, reason) => total + reason.points, 0),
    reasons,
  };
}

/** By code point, so the order doesn't depend on the server's locale. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Highest score first; ties use employee number, then UUID. */
export function compareCandidates(
  left: { score: number; employee: { employeeNumber: string; id: string } },
  right: { score: number; employee: { employeeNumber: string; id: string } },
): number {
  return (
    right.score - left.score ||
    compareText(left.employee.employeeNumber, right.employee.employeeNumber) ||
    compareText(left.employee.id, right.employee.id)
  );
}
