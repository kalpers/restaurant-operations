import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import {
  positions,
  restaurantAreas,
  scheduleGenerationRuns,
  schedulePeriods,
  shiftAssignments,
  shifts,
} from "@/db/schema";
import type {
  DatabaseExecutor,
  DatabaseTransaction,
} from "@/db/transactions/transaction-context";

export function findPeriods(
  executor: DatabaseExecutor,
  locationId: string,
  statuses: readonly string[],
) {
  return executor
    .select()
    .from(schedulePeriods)
    .where(
      and(
        eq(schedulePeriods.locationId, locationId),
        inArray(schedulePeriods.status, [...statuses]),
      ),
    )
    .orderBy(desc(schedulePeriods.startDate));
}

export async function findPeriod(
  executor: DatabaseExecutor,
  periodId: string,
  locationId: string,
) {
  const [row] = await executor
    .select()
    .from(schedulePeriods)
    .where(
      and(
        eq(schedulePeriods.id, periodId),
        eq(schedulePeriods.locationId, locationId),
      ),
    );

  return row;
}

export async function lockPeriod(
  transaction: DatabaseTransaction,
  periodId: string,
  locationId: string,
) {
  const [row] = await transaction
    .select()
    .from(schedulePeriods)
    .where(
      and(
        eq(schedulePeriods.id, periodId),
        eq(schedulePeriods.locationId, locationId),
      ),
    )
    .for("update");

  return row;
}

export type PeriodRow = NonNullable<Awaited<ReturnType<typeof findPeriod>>>;

export async function insertPeriod(
  executor: DatabaseExecutor,
  values: typeof schedulePeriods.$inferInsert,
) {
  const [row] = await executor.insert(schedulePeriods).values(values).returning();

  if (!row) {
    throw new Error("Schedule period insert returned no row.");
  }

  return row;
}

/** Applies changes and advances the version. The caller already holds the row lock. */
export async function updatePeriodRow(
  transaction: DatabaseTransaction,
  periodId: string,
  changes: Partial<typeof schedulePeriods.$inferInsert> = {},
) {
  const [row] = await transaction
    .update(schedulePeriods)
    .set({ ...changes, version: nextVersion(schedulePeriods.version) })
    .where(eq(schedulePeriods.id, periodId))
    .returning();

  if (!row) {
    throw new Error("Schedule period update returned no row.");
  }

  return row;
}

export async function hasShiftsOutside(
  executor: DatabaseExecutor,
  periodId: string,
  range: { startDate: string; endDate: string },
): Promise<boolean> {
  const rows = await executor
    .select({ id: shifts.id })
    .from(shifts)
    .where(
      and(
        eq(shifts.schedulePeriodId, periodId),
        isNull(shifts.cancelledAt),
        or(
          lt(shifts.shiftDate, range.startDate),
          gt(shifts.shiftDate, range.endDate),
        ),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

export async function insertShift(
  executor: DatabaseExecutor,
  values: typeof shifts.$inferInsert,
) {
  const [row] = await executor.insert(shifts).values(values).returning();

  if (!row) {
    throw new Error("Shift insert returned no row.");
  }

  return row;
}

/** Null when the requirement and date already have a shift. It's never overwritten. */
export async function insertTemplateShift(
  executor: DatabaseExecutor,
  values: typeof shifts.$inferInsert,
): Promise<boolean> {
  const rows = await executor
    .insert(shifts)
    .values(values)
    .onConflictDoNothing({
      target: [shifts.schedulePeriodId, shifts.sourceRequirementId, shifts.shiftDate],
    })
    .returning({ id: shifts.id });

  return rows.length > 0;
}

export async function findShiftAtLocation(
  executor: DatabaseExecutor,
  shiftId: string,
  locationId: string,
) {
  const [row] = await executor
    .select()
    .from(shifts)
    .where(and(eq(shifts.id, shiftId), eq(shifts.locationId, locationId)));

  return row;
}

export type ShiftRow = NonNullable<Awaited<ReturnType<typeof findShiftAtLocation>>>;

export async function updateShiftRow(
  executor: DatabaseExecutor,
  shiftId: string,
  expectedVersion: number,
  changes: Partial<typeof shifts.$inferInsert>,
) {
  return executor
    .update(shifts)
    .set({ ...changes, version: nextVersion(shifts.version) })
    .where(and(eq(shifts.id, shiftId), eq(shifts.version, expectedVersion)))
    .returning();
}

export function findPeriodShifts(executor: DatabaseExecutor, periodId: string) {
  return executor
    .select({
      id: shifts.id,
      schedulePeriodId: shifts.schedulePeriodId,
      locationId: shifts.locationId,
      positionId: shifts.positionId,
      positionName: positions.name,
      restaurantAreaId: shifts.restaurantAreaId,
      restaurantAreaName: restaurantAreas.name,
      shiftDate: shifts.shiftDate,
      startAt: shifts.startAt,
      endAt: shifts.endAt,
      requiredEmployeeCount: shifts.requiredEmployeeCount,
      courseOrStationNote: shifts.courseOrStationNote,
      notes: shifts.notes,
      priority: shifts.priority,
      version: shifts.version,
    })
    .from(shifts)
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .leftJoin(restaurantAreas, eq(restaurantAreas.id, shifts.restaurantAreaId))
    .where(and(eq(shifts.schedulePeriodId, periodId), isNull(shifts.cancelledAt)))
    .orderBy(asc(shifts.startAt), asc(positions.name), asc(shifts.id));
}

export type PeriodShiftRow = Awaited<ReturnType<typeof findPeriodShifts>>[number];

export function findActiveAssignmentsForPeriod(
  executor: DatabaseExecutor,
  periodId: string,
) {
  return executor
    .select({
      id: shiftAssignments.id,
      shiftId: shiftAssignments.shiftId,
      employeeId: shiftAssignments.employeeId,
      assignmentSource: shiftAssignments.assignmentSource,
      assignedAt: shiftAssignments.assignedAt,
      notes: shiftAssignments.notes,
      generationRationale: shiftAssignments.generationRationale,
      version: shiftAssignments.version,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(
      and(
        eq(shifts.schedulePeriodId, periodId),
        isNull(shifts.cancelledAt),
        eq(shiftAssignments.status, "ACTIVE"),
      ),
    )
    .orderBy(asc(shiftAssignments.assignedAt), asc(shiftAssignments.id));
}

export async function findActiveAssignmentsForShift(
  executor: DatabaseExecutor,
  shiftId: string,
) {
  return executor
    .select({
      id: shiftAssignments.id,
      employeeId: shiftAssignments.employeeId,
    })
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.shiftId, shiftId),
        eq(shiftAssignments.status, "ACTIVE"),
      ),
    );
}

export async function insertAssignment(
  executor: DatabaseExecutor,
  values: typeof shiftAssignments.$inferInsert,
) {
  const [row] = await executor
    .insert(shiftAssignments)
    .values(values)
    .returning({ id: shiftAssignments.id });

  if (!row) {
    throw new Error("Shift assignment insert returned no row.");
  }

  return row;
}

export async function findAssignmentWithShift(
  executor: DatabaseExecutor,
  assignmentId: string,
  locationId: string,
) {
  const [row] = await executor
    .select({
      id: shiftAssignments.id,
      employeeId: shiftAssignments.employeeId,
      status: shiftAssignments.status,
      assignmentSource: shiftAssignments.assignmentSource,
      generationRationale: shiftAssignments.generationRationale,
      shiftId: shifts.id,
      periodId: shifts.schedulePeriodId,
      locationId: shifts.locationId,
      positionId: shifts.positionId,
      shiftDate: shifts.shiftDate,
      startAt: shifts.startAt,
      endAt: shifts.endAt,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(
      and(
        eq(shiftAssignments.id, assignmentId),
        eq(shifts.locationId, locationId),
      ),
    );

  return row;
}

export async function endAssignmentRow(
  executor: DatabaseExecutor,
  assignmentId: string,
  values: { status: "REMOVED" | "SWAPPED"; endedByUserId: string },
) {
  await executor
    .update(shiftAssignments)
    .set({
      ...values,
      endedAt: new Date(),
      version: nextVersion(shiftAssignments.version),
    })
    .where(
      and(
        eq(shiftAssignments.id, assignmentId),
        eq(shiftAssignments.status, "ACTIVE"),
      ),
    );
}

export async function insertGenerationRun(
  executor: DatabaseExecutor,
  values: typeof scheduleGenerationRuns.$inferInsert,
) {
  const [row] = await executor
    .insert(scheduleGenerationRuns)
    .values(values)
    .returning({ id: scheduleGenerationRuns.id });

  if (!row) {
    throw new Error("Generation run insert returned no row.");
  }

  return row;
}

export async function updateGenerationRun(
  executor: DatabaseExecutor,
  runId: string,
  changes: Partial<typeof scheduleGenerationRuns.$inferInsert>,
) {
  await executor
    .update(scheduleGenerationRuns)
    .set(changes)
    .where(eq(scheduleGenerationRuns.id, runId));
}

export function findGenerationRuns(executor: DatabaseExecutor, periodId: string) {
  return executor
    .select()
    .from(scheduleGenerationRuns)
    .where(eq(scheduleGenerationRuns.schedulePeriodId, periodId))
    .orderBy(desc(scheduleGenerationRuns.startedAt));
}
