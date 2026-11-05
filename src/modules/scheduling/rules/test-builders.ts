import { addDays, localToInstant, timeToMinutes } from "@/shared/time/zoned-time";

import type { AvailabilityType } from "../types";
import type { RecurringAvailability } from "./availability-evaluator";
import type {
  EligibilityShift,
  EmployeeFacts,
  EmployeeScheduleContext,
} from "./eligibility";
import {
  DEFAULT_RULE_ROW,
  toRuleSet,
  type ScheduledShift,
  type SchedulingRuleRow,
  type SchedulingRuleSet,
} from "./schedule-rules";

// Builders for the pure rule tests. They hold no decisions of their own.

export const TZ = "America/Detroit";
export const LOCATION = "location-a";
export const POSITION = "position-server";
export const PERIOD = "period-1";

export function at(date: string, time: string): Date {
  return localToInstant(date, time, TZ)!;
}

export function shift(
  date: string,
  start: string,
  end: string,
  overrides: Partial<EligibilityShift> = {},
): EligibilityShift {
  const overnight = timeToMinutes(end) <= timeToMinutes(start);

  return {
    id: `shift-${date}-${start}`,
    locationId: LOCATION,
    positionId: POSITION,
    shiftDate: date,
    startAt: at(date, start),
    endAt: at(overnight ? addDays(date, 1) : date, end),
    ...overrides,
  };
}

export function scheduled(
  date: string,
  start: string,
  end: string,
  periodId = PERIOD,
): ScheduledShift {
  const { id, shiftDate, startAt, endAt } = shift(date, start, end);

  return { shiftId: id, periodId, shiftDate, startAt, endAt };
}

export function recurring(
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  availabilityType: AvailabilityType = "AVAILABLE",
  overrides: Partial<RecurringAvailability> = {},
): RecurringAvailability {
  return {
    locationId: null,
    dayOfWeek,
    startTime,
    endTime,
    availabilityType,
    effectiveFrom: "2020-01-01",
    effectiveTo: null,
    ...overrides,
  };
}

/** Available all day, every day, so a test can isolate some other rule. */
export const ALWAYS_AVAILABLE: readonly RecurringAvailability[] = [
  0, 1, 2, 3, 4, 5, 6,
].map((day) => recurring(day, "00:00", "00:00"));

export function employee(overrides: Partial<EmployeeFacts> = {}): EmployeeFacts {
  return {
    id: "employee-a",
    employeeNumber: "E-001",
    displayName: "Jane Smith",
    employmentStatus: "ACTIVE",
    locations: [
      { locationId: LOCATION, effectiveFrom: "2020-01-01", effectiveTo: null },
    ],
    positions: [
      {
        positionId: POSITION,
        locationId: LOCATION,
        effectiveFrom: "2020-01-01",
        effectiveTo: null,
      },
    ],
    ...overrides,
  };
}

export function context(
  overrides: Partial<EmployeeScheduleContext> = {},
): EmployeeScheduleContext {
  return {
    recurring: ALWAYS_AVAILABLE,
    exceptions: [],
    approvedTimeOff: [],
    pendingTimeOff: [],
    assignments: [],
    preferences: null,
    ...overrides,
  };
}

export function preferences(
  overrides: Partial<NonNullable<EmployeeScheduleContext["preferences"]>>,
): NonNullable<EmployeeScheduleContext["preferences"]> {
  return {
    targetMs: null,
    minimumMs: null,
    maximumMs: null,
    maximumDaysPerWeek: null,
    maximumConsecutiveDays: null,
    preferredShiftStart: null,
    preferredShiftEnd: null,
    preferWeekends: null,
    preferOpening: null,
    preferClosing: null,
    ...overrides,
  };
}

export function rules(
  overrides: Partial<SchedulingRuleRow> = {},
): SchedulingRuleSet {
  return toRuleSet({ ...DEFAULT_RULE_ROW, ...overrides });
}

export const HOUR_MS = 60 * 60 * 1000;
