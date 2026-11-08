import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";

import { schedulePeriods, shiftAssignments, shifts } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

/**
 * The one scheduling fact Seating needs: who is on a published shift at this instant, and
 * in which position. Only ACTIVE assignments on uncancelled shifts in PUBLISHED periods
 * count, using the half-open interval `start_at <= instant < end_at`.
 */
export async function findPublishedShiftsAt(
  executor: DatabaseExecutor,
  input: { locationId: string; instant: Date; employeeIds?: readonly string[] },
): Promise<{ employeeId: string; positionId: string }[]> {
  if (input.employeeIds?.length === 0) {
    return [];
  }

  return executor
    .select({
      employeeId: shiftAssignments.employeeId,
      positionId: shifts.positionId,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(schedulePeriods, eq(schedulePeriods.id, shifts.schedulePeriodId))
    .where(
      and(
        eq(shifts.locationId, input.locationId),
        eq(schedulePeriods.status, "PUBLISHED"),
        eq(shiftAssignments.status, "ACTIVE"),
        isNull(shifts.cancelledAt),
        lte(shifts.startAt, input.instant),
        gt(shifts.endAt, input.instant),
        input.employeeIds
          ? inArray(shiftAssignments.employeeId, [...input.employeeIds])
          : undefined,
      ),
    );
}
