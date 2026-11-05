import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import {
  employeeLocations,
  employeePositions,
  employees,
  employeeStatusHistory,
  locations,
  positions,
  users,
} from "@/db/schema";
import type {
  DatabaseExecutor,
  DatabaseTransaction,
} from "@/db/transactions/transaction-context";

export type EmployeeScope = { organizationId: string; locationId: string };

/** Has a location row, current or ended, here. Ended rows keep past staff reachable. */
function inScope(employeeId: string, scope: EmployeeScope): SQL | undefined {
  return and(
    eq(employees.id, employeeId),
    eq(employees.organizationId, scope.organizationId),
    atLocation(scope.locationId),
  );
}

function atLocation(locationId: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${employeeLocations}
    WHERE ${employeeLocations.employeeId} = ${employees.id}
      AND ${employeeLocations.locationId} = ${locationId}
  )`;
}

/** No restricted columns: this is what access checks and workflows need to decide. */
const CORE_COLUMNS = {
  id: employees.id,
  organizationId: employees.organizationId,
  userId: employees.userId,
  hireDate: employees.hireDate,
  employmentStatus: employees.employmentStatus,
  primaryLocationId: employees.primaryLocationId,
  version: employees.version,
};

export async function findEmployeeCore(
  executor: DatabaseExecutor,
  employeeId: string,
  scope: EmployeeScope,
) {
  const [employee] = await executor
    .select(CORE_COLUMNS)
    .from(employees)
    .where(inScope(employeeId, scope));

  return employee;
}

/** Serializes changes to one employee and everything effective-dated under them. */
export async function lockEmployeeCore(
  transaction: DatabaseTransaction,
  employeeId: string,
  scope: EmployeeScope,
) {
  const [employee] = await transaction
    .select(CORE_COLUMNS)
    .from(employees)
    .where(inScope(employeeId, scope))
    .for("update", { of: employees });

  return employee;
}

export type EmployeeCore = NonNullable<
  Awaited<ReturnType<typeof findEmployeeCore>>
>;

export function findDirectoryRows(
  executor: DatabaseExecutor,
  scope: EmployeeScope,
) {
  return executor
    .select({
      id: employees.id,
      employeeNumber: employees.employeeNumber,
      firstName: employees.firstName,
      lastName: employees.lastName,
      preferredName: employees.preferredName,
      employmentType: employees.employmentType,
      employmentStatus: employees.employmentStatus,
      primaryLocationName: locations.name,
    })
    .from(employees)
    .leftJoin(locations, eq(locations.id, employees.primaryLocationId))
    .where(
      and(
        eq(employees.organizationId, scope.organizationId),
        atLocation(scope.locationId),
      ),
    )
    .orderBy(
      asc(employees.lastName),
      asc(employees.firstName),
      asc(employees.employeeNumber),
    );
}

export async function findPrimaryPositionNames(
  executor: DatabaseExecutor,
  employeeIds: readonly string[],
  locationId: string,
): Promise<Map<string, string>> {
  if (employeeIds.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({
      employeeId: employeePositions.employeeId,
      name: positions.name,
    })
    .from(employeePositions)
    .innerJoin(positions, eq(positions.id, employeePositions.positionId))
    .where(
      and(
        inArray(employeePositions.employeeId, [...employeeIds]),
        eq(employeePositions.locationId, locationId),
        eq(employeePositions.primaryPosition, true),
        eq(employeePositions.active, true),
      ),
    );

  return new Map(rows.map((row) => [row.employeeId, row.name]));
}

export async function findGeneralRow(
  executor: DatabaseExecutor,
  employeeId: string,
  scope: EmployeeScope,
) {
  const [employee] = await executor
    .select({
      id: employees.id,
      employeeNumber: employees.employeeNumber,
      firstName: employees.firstName,
      middleName: employees.middleName,
      lastName: employees.lastName,
      preferredName: employees.preferredName,
      workEmail: employees.workEmail,
      hireDate: employees.hireDate,
      employmentType: employees.employmentType,
      primaryLocationId: employees.primaryLocationId,
      version: employees.version,
    })
    .from(employees)
    .where(inScope(employeeId, scope));

  return employee;
}

type NewEmployee = {
  organizationId: string;
  employeeNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  preferredName: string | null;
  workEmail: string | null;
  hireDate: string;
  employmentType: string;
  primaryLocationId: string;
};

export async function insertEmployee(
  executor: DatabaseExecutor,
  values: NewEmployee,
) {
  const [employee] = await executor
    .insert(employees)
    .values(values)
    .returning({ id: employees.id, version: employees.version });

  if (!employee) {
    throw new Error("Employee insert returned no row.");
  }

  return employee;
}

type EmployeeChanges = Partial<{
  firstName: string;
  middleName: string | null;
  lastName: string;
  preferredName: string | null;
  workEmail: string | null;
  employmentType: string;
  personalEmail: string | null;
  phone: string | null;
  employmentStatus: string;
  terminationDate: string | null;
  primaryLocationId: string | null;
  userId: string | null;
}>;

/** Returns no rows when the version is stale. */
export function updateEmployeeRow(
  executor: DatabaseExecutor,
  employeeId: string,
  expectedVersion: number,
  changes: EmployeeChanges,
) {
  return executor
    .update(employees)
    .set({ ...changes, version: nextVersion(employees.version) })
    .where(
      and(eq(employees.id, employeeId), eq(employees.version, expectedVersion)),
    )
    .returning({ id: employees.id, version: employees.version });
}

export async function insertStatusHistory(
  executor: DatabaseExecutor,
  values: {
    employeeId: string;
    status: string;
    reason: string | null;
    changedByUserId: string;
  },
): Promise<void> {
  await executor.insert(employeeStatusHistory).values(values);
}

export function findStatusHistoryRows(
  executor: DatabaseExecutor,
  employeeId: string,
) {
  return executor
    .select({
      id: employeeStatusHistory.id,
      status: employeeStatusHistory.status,
      effectiveAt: employeeStatusHistory.effectiveAt,
      reason: employeeStatusHistory.reason,
      changedByEmail: users.email,
    })
    .from(employeeStatusHistory)
    .innerJoin(users, eq(users.id, employeeStatusHistory.changedByUserId))
    .where(eq(employeeStatusHistory.employeeId, employeeId))
    .orderBy(desc(employeeStatusHistory.effectiveAt));
}

export async function findEmploymentRow(
  executor: DatabaseExecutor,
  employeeId: string,
) {
  const [row] = await executor
    .select({
      employmentStatus: employees.employmentStatus,
      terminationDate: employees.terminationDate,
      version: employees.version,
    })
    .from(employees)
    .where(eq(employees.id, employeeId));

  return row;
}

export async function findPersonalRow(
  executor: DatabaseExecutor,
  employeeId: string,
) {
  const [row] = await executor
    .select({
      personalEmail: employees.personalEmail,
      phone: employees.phone,
      version: employees.version,
    })
    .from(employees)
    .where(eq(employees.id, employeeId));

  return row;
}

export async function findLinkedUserId(
  executor: DatabaseExecutor,
  employeeId: string,
): Promise<string | null> {
  const [row] = await executor
    .select({ userId: employees.userId })
    .from(employees)
    .where(eq(employees.id, employeeId));

  return row?.userId ?? null;
}

/** The location, if it belongs to the organization. */
export async function findLocationInOrganization(
  executor: DatabaseExecutor,
  locationId: string,
  organizationId: string,
) {
  const [location] = await executor
    .select({
      id: locations.id,
      timezone: locations.timezone,
      active: locations.active,
    })
    .from(locations)
    .where(
      and(
        eq(locations.id, locationId),
        eq(locations.organizationId, organizationId),
      ),
    );

  return location;
}
