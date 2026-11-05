import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { findSchedulingFacts } from "@/modules/employees/queries/scheduling-facts";

import {
  findActiveAssignmentsForPeriod,
  findPeriodShifts,
} from "../repositories/schedule-repository";
import { softWarningsFor } from "../rules/candidate-scorer";
import {
  analyzeCoverage,
  type CoverageWarning,
  type EmployeeWeekHours,
} from "../rules/coverage-analyzer";
import { weekStartOf } from "../rules/schedule-rules";
import { assertCanReview, requireVisiblePeriod } from "./access";
import { findPeriodViolations } from "./schedule-service";
import { loadEmployeeContexts, loadLocationContext, withoutShift } from "./scheduling-input";

/**
 * Coverage for manual and generated schedules alike. Hard violations are assignments that
 * must be fixed before publishing, or moved by swap on a published schedule.
 */
export async function getPeriodCoverage(
  executor: DatabaseExecutor,
  actor: Actor,
  periodId: string,
) {
  assertCanReview(actor);

  const period = await requireVisiblePeriod(executor, actor, periodId);
  const [shifts, assignments] = await Promise.all([
    findPeriodShifts(executor, periodId),
    findActiveAssignmentsForPeriod(executor, periodId),
  ]);
  const employeeIds = [...new Set(assignments.map((row) => row.employeeId))];
  const facts = await findSchedulingFacts(executor, {
    organizationId: actor.organizationId,
    employeeIds,
  });
  const names = new Map(facts.map((row) => [row.id, row.displayName]));
  const { timeZone, rules } = await loadLocationContext(executor, actor);
  const contexts = await loadEmployeeContexts(executor, {
    employeeIds,
    locationId: period.locationId,
    timeZone,
    from: period.startDate,
    to: period.endDate,
  });
  const shiftsById = new Map(shifts.map((shift) => [shift.id, shift]));
  const assignedCount = new Map<string, number>();

  for (const assignment of assignments) {
    assignedCount.set(
      assignment.shiftId,
      (assignedCount.get(assignment.shiftId) ?? 0) + 1,
    );
  }

  const employeeWeeks: EmployeeWeekHours[] = [];

  for (const employeeId of employeeIds) {
    const context = contexts.get(employeeId);

    if (!context) {
      continue;
    }

    const weeks = new Set(
      assignments
        .filter((row) => row.employeeId === employeeId)
        .flatMap((row) => {
          const shift = shiftsById.get(row.shiftId);

          return shift ? [weekStartOf(shift.shiftDate, rules.weekStartDay)] : [];
        }),
    );

    for (const weekStart of weeks) {
      const scheduledMs = context.assignments
        .filter(
          (shift) =>
            weekStartOf(shift.shiftDate, rules.weekStartDay) === weekStart,
        )
        .reduce(
          (total, shift) => total + Number(shift.endAt) - Number(shift.startAt),
          0,
        );

      employeeWeeks.push({
        employeeId,
        displayName: names.get(employeeId) ?? "Unknown",
        weekStart,
        scheduledMs,
        targetMs: context.preferences?.targetMs ?? null,
        minimumMs: context.preferences?.minimumMs ?? null,
        maximumMs: context.preferences?.maximumMs ?? null,
      });
    }
  }

  const coverage = analyzeCoverage({
    shifts: shifts.map((shift) => ({
      id: shift.id,
      shiftDate: shift.shiftDate,
      positionId: shift.positionId,
      positionName: shift.positionName,
      restaurantAreaId: shift.restaurantAreaId,
      restaurantAreaName: shift.restaurantAreaName,
      requiredEmployeeCount: shift.requiredEmployeeCount,
      assignedCount: assignedCount.get(shift.id) ?? 0,
    })),
    employeeWeeks,
    overtimeThresholdMs: rules.avoidOvertime ? rules.overtimeThresholdMs : null,
  });
  const assignmentWarnings: CoverageWarning[] = assignments.flatMap(
    (assignment) => {
      const shift = shiftsById.get(assignment.shiftId);
      const context = contexts.get(assignment.employeeId);

      if (!shift || !context) {
        return [];
      }

      return softWarningsFor({
        shift,
        context: withoutShift(context, shift.id),
        rules,
      })
        // Overtime is reported once per employee and week by the analyzer.
        .filter((warning) => warning.code !== "PROJECTED_OVERTIME")
        .map((warning) => ({
          code: warning.code,
          employeeId: assignment.employeeId,
          shiftId: shift.id,
          message: `${names.get(assignment.employeeId) ?? "Unknown"}, ${shift.shiftDate}: ${warning.message}`,
        }));
    },
  );

  return {
    ...coverage,
    warnings: [...coverage.warnings, ...assignmentWarnings],
    hardViolations: await findPeriodViolations(executor, actor, period),
  };
}
