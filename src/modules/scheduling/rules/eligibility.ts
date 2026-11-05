import {
  evaluateAvailability,
  type AvailabilityException,
  type RecurringAvailability,
} from "./availability-evaluator";
import { overlaps } from "./intervals";
import {
  projectWeek,
  shortestRestMs,
  type ScheduledShift,
  type SchedulingRuleSet,
} from "./schedule-rules";

/**
 * What qualifies someone: HR facts only. Security roles are never an input, so a role
 * can't make anyone eligible, and compensation and restricted HR data aren't available
 * here to be used.
 */
export type EmployeeFacts = {
  id: string;
  employeeNumber: string;
  displayName: string;
  employmentStatus: string;
  locations: readonly {
    locationId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[];
  positions: readonly {
    positionId: string;
    locationId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[];
};

export type EmployeePreferences = {
  targetMs: number | null;
  minimumMs: number | null;
  maximumMs: number | null;
  maximumDaysPerWeek: number | null;
  maximumConsecutiveDays: number | null;
  preferredShiftStart: string | null;
  preferredShiftEnd: string | null;
  preferWeekends: boolean | null;
  preferOpening: boolean | null;
  preferClosing: boolean | null;
};

export type TimeSpan = { startAt: Date; endAt: Date };

/** Everything else about one employee that a decision can read. */
export type EmployeeScheduleContext = {
  recurring: readonly RecurringAvailability[];
  exceptions: readonly AvailabilityException[];
  approvedTimeOff: readonly TimeSpan[];
  pendingTimeOff: readonly TimeSpan[];
  assignments: readonly ScheduledShift[];
  preferences: EmployeePreferences | null;
};

export type EligibilityShift = {
  id: string;
  locationId: string;
  positionId: string;
  shiftDate: string;
  startAt: Date;
  endAt: Date;
};

export type HardConstraintCode =
  | "EMPLOYEE_NOT_SCHEDULABLE"
  | "LOCATION_NOT_ELIGIBLE"
  | "POSITION_NOT_HELD"
  | "APPROVED_TIME_OFF"
  | "AVAILABILITY_UNAVAILABLE"
  | "AVAILABILITY_NOT_COVERED"
  | "AVAILABILITY_NOT_CONFIGURED"
  | "SHIFT_OVERLAP"
  | "HARD_WEEKLY_HOURS"
  | "HARD_WEEKLY_DAYS"
  | "HARD_CONSECUTIVE_DAYS"
  | "HARD_MINIMUM_REST";

export const HARD_CONSTRAINT_MESSAGES: Record<HardConstraintCode, string> = {
  EMPLOYEE_NOT_SCHEDULABLE: "The employee can't be scheduled right now.",
  LOCATION_NOT_ELIGIBLE: "The employee isn't eligible at this location on that date.",
  POSITION_NOT_HELD: "The employee doesn't hold this position here on that date.",
  APPROVED_TIME_OFF: "The employee has approved time off during this shift.",
  AVAILABILITY_UNAVAILABLE: "The employee is marked unavailable during this shift.",
  AVAILABILITY_NOT_COVERED: "The employee's availability doesn't cover the whole shift.",
  AVAILABILITY_NOT_CONFIGURED: "The employee has no availability set up for this shift.",
  SHIFT_OVERLAP: "The employee is already assigned to an overlapping shift.",
  HARD_WEEKLY_HOURS: "This would exceed the maximum weekly hours.",
  HARD_WEEKLY_DAYS: "This would exceed the maximum days per week.",
  HARD_CONSECUTIVE_DAYS: "This would exceed the maximum consecutive days.",
  HARD_MINIMUM_REST: "This wouldn't leave the minimum rest between shifts.",
};

/** The checks a manager sees, each covering the listed failures. */
const CHECK_GROUPS: readonly {
  code: string;
  label: string;
  failures: readonly HardConstraintCode[];
}[] = [
  { code: "SCHEDULABLE", label: "Schedulable", failures: ["EMPLOYEE_NOT_SCHEDULABLE"] },
  { code: "LOCATION", label: "Eligible at location", failures: ["LOCATION_NOT_ELIGIBLE"] },
  { code: "POSITION", label: "Holds the position", failures: ["POSITION_NOT_HELD"] },
  {
    code: "AVAILABILITY",
    label: "Available for the whole shift",
    failures: [
      "AVAILABILITY_UNAVAILABLE",
      "AVAILABILITY_NOT_COVERED",
      "AVAILABILITY_NOT_CONFIGURED",
    ],
  },
  { code: "TIME_OFF", label: "No approved time off", failures: ["APPROVED_TIME_OFF"] },
  { code: "OVERLAP", label: "No overlapping shift", failures: ["SHIFT_OVERLAP"] },
  {
    code: "LIMITS",
    label: "Within hard limits",
    failures: [
      "HARD_WEEKLY_HOURS",
      "HARD_WEEKLY_DAYS",
      "HARD_CONSECUTIVE_DAYS",
      "HARD_MINIMUM_REST",
    ],
  },
];

export type HardCheck = { code: string; label: string; passed: boolean };

export type EligibilityResult = {
  eligible: boolean;
  violations: HardConstraintCode[];
  checks: HardCheck[];
};

function effectiveOn(
  range: { effectiveFrom: string; effectiveTo: string | null },
  date: string,
): boolean {
  return (
    range.effectiveFrom <= date &&
    (range.effectiveTo === null || date <= range.effectiveTo)
  );
}

function spansOverlap(left: TimeSpan, right: TimeSpan): boolean {
  return overlaps(
    { start: Number(left.startAt), end: Number(left.endAt) },
    { start: Number(right.startAt), end: Number(right.endAt) },
  );
}

/**
 * The hard constraints: the single evaluator behind manual assignment, generation, Fill
 * Open Shifts, swaps and publishing, so those paths can't disagree. It reports every
 * failure rather than stopping at the first. `context.assignments` must not include the
 * shift being evaluated.
 */
export function evaluateEligibility(input: {
  shift: EligibilityShift;
  employee: EmployeeFacts;
  context: EmployeeScheduleContext;
  rules: SchedulingRuleSet;
  timeZone: string;
}): EligibilityResult {
  const { shift, employee, context, rules, timeZone } = input;
  const violations: HardConstraintCode[] = [];

  if (employee.employmentStatus !== "ACTIVE") {
    violations.push("EMPLOYEE_NOT_SCHEDULABLE");
  }

  if (
    !employee.locations.some(
      (location) =>
        location.locationId === shift.locationId &&
        effectiveOn(location, shift.shiftDate),
    )
  ) {
    violations.push("LOCATION_NOT_ELIGIBLE");
  }

  if (
    !employee.positions.some(
      (position) =>
        position.positionId === shift.positionId &&
        position.locationId === shift.locationId &&
        effectiveOn(position, shift.shiftDate),
    )
  ) {
    violations.push("POSITION_NOT_HELD");
  }

  const availability = evaluateAvailability({
    shift,
    recurring: context.recurring,
    exceptions: context.exceptions,
    timeZone,
  });

  if (availability !== "AVAILABLE") {
    violations.push(availability);
  }

  if (context.approvedTimeOff.some((span) => spansOverlap(span, shift))) {
    violations.push("APPROVED_TIME_OFF");
  }

  if (context.assignments.some((other) => spansOverlap(other, shift))) {
    violations.push("SHIFT_OVERLAP");
  }

  const week = projectWeek(shift, context.assignments, rules);

  if (rules.maximumWeeklyMs !== null && week.projectedMs > rules.maximumWeeklyMs) {
    violations.push("HARD_WEEKLY_HOURS");
  }

  if (
    rules.maximumDaysHard &&
    rules.maximumDaysPerWeek !== null &&
    week.days > rules.maximumDaysPerWeek
  ) {
    violations.push("HARD_WEEKLY_DAYS");
  }

  if (
    rules.maximumConsecutiveHard &&
    rules.maximumConsecutiveDays !== null &&
    week.consecutiveDays > rules.maximumConsecutiveDays
  ) {
    violations.push("HARD_CONSECUTIVE_DAYS");
  }

  if (rules.minimumRestHard && rules.minimumRestMs !== null) {
    const rest = shortestRestMs(shift, context.assignments);

    if (rest !== null && rest < rules.minimumRestMs) {
      violations.push("HARD_MINIMUM_REST");
    }
  }

  return {
    eligible: violations.length === 0,
    violations,
    checks: CHECK_GROUPS.map((group) => ({
      code: group.code,
      label: group.label,
      passed: !group.failures.some((code) => violations.includes(code)),
    })),
  };
}
