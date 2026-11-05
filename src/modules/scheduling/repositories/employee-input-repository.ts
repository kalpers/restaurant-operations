import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import {
  employeeAvailability,
  employeeAvailabilityExceptions,
  employeeSchedulingPreferences,
  positions,
  schedulePeriods,
  shiftAssignments,
  shifts,
  timeOffRequests,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

export function findRecurringRows(
  executor: DatabaseExecutor,
  employeeIds: readonly string[],
) {
  return executor
    .select()
    .from(employeeAvailability)
    .where(
      and(
        inArray(employeeAvailability.employeeId, [...employeeIds]),
        eq(employeeAvailability.active, true),
      ),
    )
    .orderBy(
      asc(employeeAvailability.dayOfWeek),
      asc(employeeAvailability.startTime),
    );
}

export function findExceptionRows(
  executor: DatabaseExecutor,
  employeeIds: readonly string[],
  range?: { from: string; to: string },
) {
  return executor
    .select()
    .from(employeeAvailabilityExceptions)
    .where(
      and(
        inArray(employeeAvailabilityExceptions.employeeId, [...employeeIds]),
        eq(employeeAvailabilityExceptions.active, true),
        range
          ? gte(employeeAvailabilityExceptions.exceptionDate, range.from)
          : undefined,
        range
          ? lte(employeeAvailabilityExceptions.exceptionDate, range.to)
          : undefined,
      ),
    )
    .orderBy(asc(employeeAvailabilityExceptions.exceptionDate));
}

export function findPreferenceRows(
  executor: DatabaseExecutor,
  employeeIds: readonly string[],
) {
  return executor
    .select()
    .from(employeeSchedulingPreferences)
    .where(inArray(employeeSchedulingPreferences.employeeId, [...employeeIds]));
}

/** Approved and pending requests touching the window. Reasons aren't selected. */
export function findOpenTimeOffSpans(
  executor: DatabaseExecutor,
  employeeIds: readonly string[],
  window: { from: Date; to: Date },
) {
  return executor
    .select({
      employeeId: timeOffRequests.employeeId,
      status: timeOffRequests.status,
      startAt: timeOffRequests.startAt,
      endAt: timeOffRequests.endAt,
    })
    .from(timeOffRequests)
    .where(
      and(
        inArray(timeOffRequests.employeeId, [...employeeIds]),
        inArray(timeOffRequests.status, ["APPROVED", "PENDING"]),
        lt(timeOffRequests.startAt, window.to),
        gt(timeOffRequests.endAt, window.from),
      ),
    );
}

/**
 * Everything the employees actually work around the given dates, at any location and in
 * any period, so overlap and limit checks see the whole picture.
 */
export function findEmployeeAssignments(
  executor: DatabaseExecutor,
  employeeIds: readonly string[],
  range: { from: string; to: string },
) {
  return executor
    .select({
      employeeId: shiftAssignments.employeeId,
      shiftId: shifts.id,
      periodId: shifts.schedulePeriodId,
      shiftDate: shifts.shiftDate,
      startAt: shifts.startAt,
      endAt: shifts.endAt,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(
      and(
        inArray(shiftAssignments.employeeId, [...employeeIds]),
        eq(shiftAssignments.status, "ACTIVE"),
        isNull(shifts.cancelledAt),
        gte(shifts.shiftDate, range.from),
        lte(shifts.shiftDate, range.to),
      ),
    );
}

/** An employee's own shifts in published or archived schedules. Never a draft. */
export function findPublishedShiftsForEmployee(
  executor: DatabaseExecutor,
  employeeId: string,
  range: { from: string; to: string },
) {
  return executor
    .select({
      assignmentId: shiftAssignments.id,
      shiftId: shifts.id,
      locationId: shifts.locationId,
      shiftDate: shifts.shiftDate,
      startAt: shifts.startAt,
      endAt: shifts.endAt,
      positionName: positions.name,
      periodName: schedulePeriods.name,
      assignmentSource: shiftAssignments.assignmentSource,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .innerJoin(schedulePeriods, eq(schedulePeriods.id, shifts.schedulePeriodId))
    .where(
      and(
        eq(shiftAssignments.employeeId, employeeId),
        eq(shiftAssignments.status, "ACTIVE"),
        isNull(shifts.cancelledAt),
        ne(schedulePeriods.status, "DRAFT"),
        gte(shifts.shiftDate, range.from),
        lte(shifts.shiftDate, range.to),
      ),
    )
    .orderBy(asc(shifts.startAt));
}

/** Active assignments overlapping a time span, in draft or published schedules. */
export function findAssignmentConflicts(
  executor: DatabaseExecutor,
  employeeId: string,
  span: { startAt: Date; endAt: Date },
) {
  return executor
    .select({
      assignmentId: shiftAssignments.id,
      shiftDate: shifts.shiftDate,
      startAt: shifts.startAt,
      endAt: shifts.endAt,
      positionName: positions.name,
      periodName: schedulePeriods.name,
      periodStatus: schedulePeriods.status,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .innerJoin(schedulePeriods, eq(schedulePeriods.id, shifts.schedulePeriodId))
    .where(
      and(
        eq(shiftAssignments.employeeId, employeeId),
        eq(shiftAssignments.status, "ACTIVE"),
        isNull(shifts.cancelledAt),
        inArray(schedulePeriods.status, ["DRAFT", "PUBLISHED"]),
        lt(shifts.startAt, span.endAt),
        gt(shifts.endAt, span.startAt),
      ),
    )
    .orderBy(asc(shifts.startAt));
}

export async function insertRecurring(
  executor: DatabaseExecutor,
  values: typeof employeeAvailability.$inferInsert,
) {
  const [row] = await executor
    .insert(employeeAvailability)
    .values(values)
    .returning({ id: employeeAvailability.id });

  return row!;
}

export async function updateRecurringRow(
  executor: DatabaseExecutor,
  input: { id: string; employeeId: string; expectedVersion: number },
  changes: Partial<typeof employeeAvailability.$inferInsert>,
) {
  return executor
    .update(employeeAvailability)
    .set({ ...changes, version: nextVersion(employeeAvailability.version) })
    .where(
      and(
        eq(employeeAvailability.id, input.id),
        eq(employeeAvailability.employeeId, input.employeeId),
        eq(employeeAvailability.version, input.expectedVersion),
        eq(employeeAvailability.active, true),
      ),
    )
    .returning({
      id: employeeAvailability.id,
      version: employeeAvailability.version,
    });
}

export async function insertException(
  executor: DatabaseExecutor,
  values: typeof employeeAvailabilityExceptions.$inferInsert,
) {
  const [row] = await executor
    .insert(employeeAvailabilityExceptions)
    .values(values)
    .returning({ id: employeeAvailabilityExceptions.id });

  return row!;
}

export async function updateExceptionRow(
  executor: DatabaseExecutor,
  input: { id: string; employeeId: string; expectedVersion: number },
  changes: Partial<typeof employeeAvailabilityExceptions.$inferInsert>,
) {
  return executor
    .update(employeeAvailabilityExceptions)
    .set({
      ...changes,
      version: nextVersion(employeeAvailabilityExceptions.version),
    })
    .where(
      and(
        eq(employeeAvailabilityExceptions.id, input.id),
        eq(employeeAvailabilityExceptions.employeeId, input.employeeId),
        eq(employeeAvailabilityExceptions.version, input.expectedVersion),
        eq(employeeAvailabilityExceptions.active, true),
      ),
    )
    .returning({
      id: employeeAvailabilityExceptions.id,
      version: employeeAvailabilityExceptions.version,
    });
}

export async function findPreferenceRow(
  executor: DatabaseExecutor,
  employeeId: string,
) {
  const [row] = await executor
    .select()
    .from(employeeSchedulingPreferences)
    .where(
      and(
        eq(employeeSchedulingPreferences.employeeId, employeeId),
        isNull(employeeSchedulingPreferences.locationId),
      ),
    )
    .orderBy(desc(employeeSchedulingPreferences.updatedAt));

  return row;
}

export async function insertPreferenceRow(
  executor: DatabaseExecutor,
  values: typeof employeeSchedulingPreferences.$inferInsert,
) {
  const [row] = await executor
    .insert(employeeSchedulingPreferences)
    .values(values)
    .returning({
      id: employeeSchedulingPreferences.id,
      version: employeeSchedulingPreferences.version,
    });

  return row!;
}

export async function updatePreferenceRow(
  executor: DatabaseExecutor,
  input: { id: string; expectedVersion: number },
  changes: Partial<typeof employeeSchedulingPreferences.$inferInsert>,
) {
  return executor
    .update(employeeSchedulingPreferences)
    .set({
      ...changes,
      version: nextVersion(employeeSchedulingPreferences.version),
    })
    .where(
      and(
        eq(employeeSchedulingPreferences.id, input.id),
        eq(employeeSchedulingPreferences.version, input.expectedVersion),
      ),
    )
    .returning({
      id: employeeSchedulingPreferences.id,
      version: employeeSchedulingPreferences.version,
    });
}
