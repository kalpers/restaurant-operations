import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { nextVersion } from "@/db/helpers/versioning";
import {
  employeeLocations,
  positions,
  schedulePeriods,
  shiftAssignments,
  shifts,
  shiftSwapRequests,
  timeOffRequests,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

export async function insertTimeOff(
  executor: DatabaseExecutor,
  values: typeof timeOffRequests.$inferInsert,
) {
  const [row] = await executor
    .insert(timeOffRequests)
    .values(values)
    .returning({ id: timeOffRequests.id, status: timeOffRequests.status });

  return row!;
}

export async function findTimeOff(executor: DatabaseExecutor, requestId: string) {
  const [row] = await executor
    .select()
    .from(timeOffRequests)
    .where(eq(timeOffRequests.id, requestId));

  return row;
}

export async function updateTimeOffRow(
  executor: DatabaseExecutor,
  requestId: string,
  expectedVersion: number,
  changes: Partial<typeof timeOffRequests.$inferInsert>,
) {
  return executor
    .update(timeOffRequests)
    .set({ ...changes, version: nextVersion(timeOffRequests.version) })
    .where(
      and(
        eq(timeOffRequests.id, requestId),
        eq(timeOffRequests.version, expectedVersion),
      ),
    )
    .returning({
      id: timeOffRequests.id,
      status: timeOffRequests.status,
      version: timeOffRequests.version,
    });
}

export function findOwnTimeOff(executor: DatabaseExecutor, employeeId: string) {
  return executor
    .select()
    .from(timeOffRequests)
    .where(eq(timeOffRequests.employeeId, employeeId))
    .orderBy(desc(timeOffRequests.startAt));
}

/** Requests from anyone with a location row here, current or ended. */
export function findTimeOffAtLocation(
  executor: DatabaseExecutor,
  locationId: string,
) {
  return executor
    .select()
    .from(timeOffRequests)
    .where(
      sql`EXISTS (
        SELECT 1 FROM ${employeeLocations}
        WHERE ${employeeLocations.employeeId} = ${timeOffRequests.employeeId}
          AND ${employeeLocations.locationId} = ${locationId}
      )`,
    )
    .orderBy(desc(timeOffRequests.requestedAt));
}

export async function insertSwap(
  executor: DatabaseExecutor,
  values: typeof shiftSwapRequests.$inferInsert,
) {
  const [row] = await executor
    .insert(shiftSwapRequests)
    .values(values)
    .returning({ id: shiftSwapRequests.id, status: shiftSwapRequests.status });

  return row!;
}

const swapSelection = {
  id: shiftSwapRequests.id,
  shiftAssignmentId: shiftSwapRequests.shiftAssignmentId,
  requestingEmployeeId: shiftSwapRequests.requestingEmployeeId,
  targetEmployeeId: shiftSwapRequests.targetEmployeeId,
  status: shiftSwapRequests.status,
  reason: shiftSwapRequests.reason,
  requestedAt: shiftSwapRequests.requestedAt,
  acceptedAt: shiftSwapRequests.acceptedAt,
  approvedAt: shiftSwapRequests.approvedAt,
  replacementAssignmentId: shiftSwapRequests.replacementAssignmentId,
  version: shiftSwapRequests.version,
  shiftId: shifts.id,
  periodId: shifts.schedulePeriodId,
  locationId: shifts.locationId,
  shiftDate: shifts.shiftDate,
  startAt: shifts.startAt,
  endAt: shifts.endAt,
  positionName: positions.name,
};

const originalAssignments = alias(shiftAssignments, "original_assignments");

function swapQuery(executor: DatabaseExecutor) {
  return executor
    .select(swapSelection)
    .from(shiftSwapRequests)
    .innerJoin(
      originalAssignments,
      eq(originalAssignments.id, shiftSwapRequests.shiftAssignmentId),
    )
    .innerJoin(shifts, eq(shifts.id, originalAssignments.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId));
}

export async function findSwap(
  executor: DatabaseExecutor,
  swapId: string,
  locationId: string,
) {
  const [row] = await swapQuery(executor).where(
    and(eq(shiftSwapRequests.id, swapId), eq(shifts.locationId, locationId)),
  );

  return row;
}

export type SwapRow = NonNullable<Awaited<ReturnType<typeof findSwap>>>;

export function findSwapsAtLocation(
  executor: DatabaseExecutor,
  locationId: string,
) {
  return swapQuery(executor)
    .where(eq(shifts.locationId, locationId))
    .orderBy(desc(shiftSwapRequests.requestedAt));
}

export function findSwapsForEmployee(
  executor: DatabaseExecutor,
  employeeId: string,
) {
  return swapQuery(executor)
    .where(
      or(
        eq(shiftSwapRequests.requestingEmployeeId, employeeId),
        eq(shiftSwapRequests.targetEmployeeId, employeeId),
      ),
    )
    .orderBy(desc(shiftSwapRequests.requestedAt));
}

export async function updateSwapRow(
  executor: DatabaseExecutor,
  swapId: string,
  expectedVersion: number,
  changes: Partial<typeof shiftSwapRequests.$inferInsert>,
) {
  return executor
    .update(shiftSwapRequests)
    .set({ ...changes, version: nextVersion(shiftSwapRequests.version) })
    .where(
      and(
        eq(shiftSwapRequests.id, swapId),
        eq(shiftSwapRequests.version, expectedVersion),
        inArray(shiftSwapRequests.status, ["PENDING", "ACCEPTED"]),
      ),
    )
    .returning({
      id: shiftSwapRequests.id,
      status: shiftSwapRequests.status,
      version: shiftSwapRequests.version,
    });
}

export async function findPeriodStatus(
  executor: DatabaseExecutor,
  periodId: string,
) {
  const [row] = await executor
    .select({ status: schedulePeriods.status })
    .from(schedulePeriods)
    .where(eq(schedulePeriods.id, periodId));

  return row?.status;
}
