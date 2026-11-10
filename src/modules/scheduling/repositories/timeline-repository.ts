import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import {
  positions,
  restaurantAreas,
  scheduleGenerationRuns,
  schedulePeriods,
  shiftAssignments,
  shifts,
  shiftSwapRequests,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

// Reads behind the day timeline. Each one is a single query over a set of IDs, so a day
// costs the same number of queries whatever the staff count.

/** Periods at the location whose dates include the day. */
export function findPeriodsCoveringDate(
  executor: DatabaseExecutor,
  input: { locationId: string; date: string; statuses: readonly string[] },
) {
  return executor
    .select()
    .from(schedulePeriods)
    .where(
      and(
        eq(schedulePeriods.locationId, input.locationId),
        inArray(schedulePeriods.status, [...input.statuses]),
        lte(schedulePeriods.startDate, input.date),
        gte(schedulePeriods.endDate, input.date),
      ),
    )
    .orderBy(asc(schedulePeriods.startDate), asc(schedulePeriods.id));
}

/** Uncancelled shifts whose `shift_date` is the day, in the given periods. */
export function findShiftsOnDate(
  executor: DatabaseExecutor,
  input: { periodIds: readonly string[]; date: string },
) {
  return executor
    .select({
      id: shifts.id,
      schedulePeriodId: shifts.schedulePeriodId,
      locationId: shifts.locationId,
      positionId: shifts.positionId,
      positionName: positions.name,
      positionCode: positions.code,
      restaurantAreaId: shifts.restaurantAreaId,
      restaurantAreaName: restaurantAreas.name,
      shiftDate: shifts.shiftDate,
      startAt: shifts.startAt,
      endAt: shifts.endAt,
      requiredEmployeeCount: shifts.requiredEmployeeCount,
      courseOrStationNote: shifts.courseOrStationNote,
      notes: shifts.notes,
    })
    .from(shifts)
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .leftJoin(restaurantAreas, eq(restaurantAreas.id, shifts.restaurantAreaId))
    .where(
      and(
        inArray(shifts.schedulePeriodId, [...input.periodIds]),
        eq(shifts.shiftDate, input.date),
        isNull(shifts.cancelledAt),
      ),
    )
    .orderBy(asc(shifts.startAt), asc(shifts.id));
}

export type TimelineShiftRow = Awaited<ReturnType<typeof findShiftsOnDate>>[number];

/** Active assignments only: removed and swapped-out rows never appear. */
export function findActiveAssignmentsForShifts(
  executor: DatabaseExecutor,
  shiftIds: readonly string[],
) {
  return executor
    .select({
      id: shiftAssignments.id,
      shiftId: shiftAssignments.shiftId,
      employeeId: shiftAssignments.employeeId,
      assignmentSource: shiftAssignments.assignmentSource,
      assignedAt: shiftAssignments.assignedAt,
      generationRationale: shiftAssignments.generationRationale,
    })
    .from(shiftAssignments)
    .where(
      and(
        inArray(shiftAssignments.shiftId, [...shiftIds]),
        eq(shiftAssignments.status, "ACTIVE"),
      ),
    )
    .orderBy(asc(shiftAssignments.assignedAt), asc(shiftAssignments.id));
}

/** Each employee's scheduled minutes across a period, from active assignments. */
export function sumActiveMinutesByEmployee(
  executor: DatabaseExecutor,
  input: { periodIds: readonly string[]; employeeIds: readonly string[] },
) {
  return executor
    .select({
      periodId: shifts.schedulePeriodId,
      employeeId: shiftAssignments.employeeId,
      minutes: sql<string>`sum(extract(epoch from (${shifts.endAt} - ${shifts.startAt})) / 60)`,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(
      and(
        inArray(shifts.schedulePeriodId, [...input.periodIds]),
        inArray(shiftAssignments.employeeId, [...input.employeeIds]),
        eq(shiftAssignments.status, "ACTIVE"),
        isNull(shifts.cancelledAt),
      ),
    )
    .groupBy(shifts.schedulePeriodId, shiftAssignments.employeeId);
}

/** Assignments with a swap still in progress. */
export async function findOpenSwapAssignmentIds(
  executor: DatabaseExecutor,
  assignmentIds: readonly string[],
): Promise<Set<string>> {
  const rows = await executor
    .selectDistinct({ id: shiftSwapRequests.shiftAssignmentId })
    .from(shiftSwapRequests)
    .where(
      and(
        inArray(shiftSwapRequests.shiftAssignmentId, [...assignmentIds]),
        inArray(shiftSwapRequests.status, ["PENDING", "ACCEPTED"]),
      ),
    );

  return new Set(rows.map((row) => row.id));
}

/** The newest completed run's unfilled details for each period. */
export async function findLatestUnfilledDetails(
  executor: DatabaseExecutor,
  periodIds: readonly string[],
): Promise<Map<string, unknown>> {
  const rows = await executor
    .select({
      periodId: scheduleGenerationRuns.schedulePeriodId,
      unfilledDetails: scheduleGenerationRuns.unfilledDetails,
    })
    .from(scheduleGenerationRuns)
    .where(
      and(
        inArray(scheduleGenerationRuns.schedulePeriodId, [...periodIds]),
        eq(scheduleGenerationRuns.status, "COMPLETED"),
      ),
    )
    .orderBy(
      asc(scheduleGenerationRuns.schedulePeriodId),
      desc(scheduleGenerationRuns.startedAt),
    );
  const latest = new Map<string, unknown>();

  for (const row of rows) {
    if (!latest.has(row.periodId)) {
      latest.set(row.periodId, row.unfilledDetails);
    }
  }

  return latest;
}
