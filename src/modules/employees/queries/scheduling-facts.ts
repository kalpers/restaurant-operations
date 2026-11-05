import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { employeeLocations, employeePositions, employees } from "@/db/schema";
import type {
  DatabaseExecutor,
  DatabaseTransaction,
} from "@/db/transactions/transaction-context";

/**
 * The only HR data Scheduling can read: identity, status, and where and as what someone
 * may work. It's deliberately narrow. No compensation, personal, disciplinary or document
 * data is selected, so scheduling logic can't use or expose it.
 */
export type SchedulingEmployeeFacts = {
  id: string;
  employeeNumber: string;
  displayName: string;
  employmentStatus: string;
  locations: {
    locationId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[];
  positions: {
    positionId: string;
    locationId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[];
};

/** Everyone with a location row here, current or ended, or exactly the given IDs. */
export async function findSchedulingFacts(
  executor: DatabaseExecutor,
  scope: {
    organizationId: string;
    locationId?: string;
    employeeIds?: readonly string[];
  },
): Promise<SchedulingEmployeeFacts[]> {
  const conditions: SQL[] = [eq(employees.organizationId, scope.organizationId)];

  if (scope.employeeIds) {
    if (scope.employeeIds.length === 0) {
      return [];
    }

    conditions.push(inArray(employees.id, [...scope.employeeIds]));
  }

  if (scope.locationId) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${employeeLocations}
      WHERE ${employeeLocations.employeeId} = ${employees.id}
        AND ${employeeLocations.locationId} = ${scope.locationId}
    )`);
  }

  const rows = await executor
    .select({
      id: employees.id,
      employeeNumber: employees.employeeNumber,
      firstName: employees.firstName,
      lastName: employees.lastName,
      preferredName: employees.preferredName,
      employmentStatus: employees.employmentStatus,
    })
    .from(employees)
    .where(and(...conditions))
    .orderBy(asc(employees.employeeNumber), asc(employees.id));

  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((row) => row.id);
  const locationRows = await executor
    .select({
      employeeId: employeeLocations.employeeId,
      locationId: employeeLocations.locationId,
      effectiveFrom: employeeLocations.effectiveFrom,
      effectiveTo: employeeLocations.effectiveTo,
    })
    .from(employeeLocations)
    .where(inArray(employeeLocations.employeeId, ids));
  const positionRows = await executor
    .select({
      employeeId: employeePositions.employeeId,
      positionId: employeePositions.positionId,
      locationId: employeePositions.locationId,
      effectiveFrom: employeePositions.effectiveFrom,
      effectiveTo: employeePositions.effectiveTo,
    })
    .from(employeePositions)
    .where(inArray(employeePositions.employeeId, ids));

  return rows.map((row) => ({
    id: row.id,
    employeeNumber: row.employeeNumber,
    displayName: `${row.preferredName ?? row.firstName} ${row.lastName}`,
    employmentStatus: row.employmentStatus,
    locations: locationRows
      .filter((location) => location.employeeId === row.id)
      .map(({ locationId, effectiveFrom, effectiveTo }) => ({
        locationId,
        effectiveFrom,
        effectiveTo,
      })),
    positions: positionRows
      .filter((position) => position.employeeId === row.id)
      .map(({ positionId, locationId, effectiveFrom, effectiveTo }) => ({
        positionId,
        locationId,
        effectiveFrom,
        effectiveTo,
      })),
  }));
}

/** The employee linked to a user. Never takes an employee ID from the caller. */
export async function findLinkedEmployeeId(
  executor: DatabaseExecutor,
  input: { userId: string; organizationId: string },
): Promise<string | null> {
  const [row] = await executor
    .select({ id: employees.id })
    .from(employees)
    .where(
      and(
        eq(employees.userId, input.userId),
        eq(employees.organizationId, input.organizationId),
      ),
    );

  return row?.id ?? null;
}

/**
 * Holds these employee rows until the transaction ends, so overlap and limit checks can't
 * race across periods. Sorted, so two writers can't deadlock.
 */
export async function lockEmployeesForScheduling(
  transaction: DatabaseTransaction,
  employeeIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(employeeIds)];

  if (unique.length > 0) {
    await transaction
      .select({ id: employees.id })
      .from(employees)
      .where(inArray(employees.id, unique))
      .orderBy(asc(employees.id))
      .for("update", { of: employees });
  }
}
