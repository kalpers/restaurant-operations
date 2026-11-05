import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { findLocationInOrganization } from "@/modules/employees/repositories/employee-repository";
import { NotFoundError } from "@/shared/errors/app-error";
import { addDays, localToInstantLenient } from "@/shared/time/zoned-time";

import { findRulesRow } from "../repositories/config-repository";
import {
  findEmployeeAssignments,
  findExceptionRows,
  findOpenTimeOffSpans,
  findPreferenceRows,
  findRecurringRows,
} from "../repositories/employee-input-repository";
import type {
  EmployeeScheduleContext,
  EmployeePreferences,
} from "../rules/eligibility";
import {
  DEFAULT_RULE_ROW,
  toRuleSet,
  type SchedulingRuleRow,
  type SchedulingRuleSet,
} from "../rules/schedule-rules";
import { hoursToMs, type AvailabilityType } from "../types";

export type LocationContext = {
  timeZone: string;
  rules: SchedulingRuleSet;
  ruleRow: SchedulingRuleRow;
};

export async function loadLocationContext(
  executor: DatabaseExecutor,
  actor: Actor,
): Promise<LocationContext> {
  const location = await findLocationInOrganization(
    executor,
    actor.locationId,
    actor.organizationId,
  );

  if (!location) {
    throw new NotFoundError("location");
  }

  const row = (await findRulesRow(executor, actor.locationId)) ?? DEFAULT_RULE_ROW;
  const ruleRow: SchedulingRuleRow = {
    avoidOvertime: row.avoidOvertime,
    weeklyOvertimeThreshold: row.weeklyOvertimeThreshold,
    minimumRestHours: row.minimumRestHours,
    minimumRestHard: row.minimumRestHard,
    maximumDaysPerWeek: row.maximumDaysPerWeek,
    maximumDaysHard: row.maximumDaysHard,
    maximumConsecutiveDays: row.maximumConsecutiveDays,
    maximumConsecutiveHard: row.maximumConsecutiveHard,
    maximumWeeklyHours: row.maximumWeeklyHours,
    balanceWeekendShifts: row.balanceWeekendShifts,
    balanceClosingShifts: row.balanceClosingShifts,
    preferTargetHours: row.preferTargetHours,
    weekStartDay: row.weekStartDay,
  };

  return { timeZone: location.timezone, rules: toRuleSet(ruleRow), ruleRow };
}

function hoursOrNull(value: string | null): number | null {
  return value === null ? null : hoursToMs(value);
}

/** How far either side of the dates to read, so weeks and day runs are complete. */
const ASSIGNMENT_MARGIN_DAYS = 31;

/**
 * The one normalized input behind every decision. It reads scheduling tables only, and
 * the time-off query doesn't select reasons. A location-specific preference row wins over
 * the employee's general one.
 */
export async function loadEmployeeContexts(
  executor: DatabaseExecutor,
  input: {
    employeeIds: readonly string[];
    locationId: string;
    timeZone: string;
    from: string;
    to: string;
  },
): Promise<Map<string, EmployeeScheduleContext>> {
  const { employeeIds, from, to, timeZone, locationId } = input;
  const contexts = new Map<string, EmployeeScheduleContext>();

  if (employeeIds.length === 0) {
    return contexts;
  }

  const [recurring, exceptions, preferences, timeOff, assignments] =
    await Promise.all([
      findRecurringRows(executor, employeeIds),
      findExceptionRows(executor, employeeIds, {
        from: addDays(from, -2),
        to: addDays(to, 2),
      }),
      findPreferenceRows(executor, employeeIds),
      findOpenTimeOffSpans(executor, employeeIds, {
        from: localToInstantLenient(addDays(from, -1), "00:00", timeZone),
        to: localToInstantLenient(addDays(to, 3), "00:00", timeZone),
      }),
      findEmployeeAssignments(executor, employeeIds, {
        from: addDays(from, -ASSIGNMENT_MARGIN_DAYS),
        to: addDays(to, ASSIGNMENT_MARGIN_DAYS),
      }),
    ]);

  for (const employeeId of employeeIds) {
    const preferenceRow = preferences
      .filter((row) => row.employeeId === employeeId)
      .filter((row) => row.locationId === null || row.locationId === locationId)
      .sort((left, right) => Number(right.locationId !== null) - Number(left.locationId !== null))[0];
    const ownTimeOff = timeOff.filter((row) => row.employeeId === employeeId);
    const preferencesFor: EmployeePreferences | null = preferenceRow
      ? {
          targetMs: hoursOrNull(preferenceRow.targetHoursPerWeek),
          minimumMs: hoursOrNull(preferenceRow.minimumHoursPerWeek),
          maximumMs: hoursOrNull(preferenceRow.maximumHoursPerWeek),
          maximumDaysPerWeek: preferenceRow.maximumDaysPerWeek,
          maximumConsecutiveDays: preferenceRow.maximumConsecutiveDays,
          preferredShiftStart: preferenceRow.preferredShiftStart,
          preferredShiftEnd: preferenceRow.preferredShiftEnd,
          preferWeekends: preferenceRow.preferWeekends,
          preferOpening: preferenceRow.preferOpening,
          preferClosing: preferenceRow.preferClosing,
        }
      : null;

    contexts.set(employeeId, {
      recurring: recurring
        .filter((row) => row.employeeId === employeeId)
        .map((row) => ({
          locationId: row.locationId,
          dayOfWeek: row.dayOfWeek,
          startTime: row.startTime,
          endTime: row.endTime,
          availabilityType: row.availabilityType as AvailabilityType,
          effectiveFrom: row.effectiveFrom,
          effectiveTo: row.effectiveTo,
        })),
      exceptions: exceptions
        .filter((row) => row.employeeId === employeeId)
        .map((row) => ({
          locationId: row.locationId,
          exceptionDate: row.exceptionDate,
          startTime: row.startTime,
          endTime: row.endTime,
          availabilityType: row.availabilityType as AvailabilityType,
        })),
      approvedTimeOff: ownTimeOff
        .filter((row) => row.status === "APPROVED")
        .map(({ startAt, endAt }) => ({ startAt, endAt })),
      pendingTimeOff: ownTimeOff
        .filter((row) => row.status === "PENDING")
        .map(({ startAt, endAt }) => ({ startAt, endAt })),
      assignments: assignments
        .filter((row) => row.employeeId === employeeId)
        .map(({ shiftId, periodId, shiftDate, startAt, endAt }) => ({
          shiftId,
          periodId,
          shiftDate,
          startAt,
          endAt,
        })),
      preferences: preferencesFor,
    });
  }

  return contexts;
}

/** The context as a decision about this shift needs it: without the shift itself. */
export function withoutShift(
  context: EmployeeScheduleContext,
  shiftId: string,
): EmployeeScheduleContext {
  return {
    ...context,
    assignments: context.assignments.filter(
      (assignment) => assignment.shiftId !== shiftId,
    ),
  };
}
