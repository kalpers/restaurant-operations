import { and, eq, inArray } from "drizzle-orm";

import { employees } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

/** Employee ID to name, and nothing else, for screens that only need to say who. */
export async function findEmployeeDisplayNames(
  executor: DatabaseExecutor,
  input: { organizationId: string; employeeIds: readonly string[] },
): Promise<Map<string, string>> {
  const ids = [...new Set(input.employeeIds)];

  if (ids.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({
      id: employees.id,
      firstName: employees.firstName,
      preferredName: employees.preferredName,
      lastName: employees.lastName,
    })
    .from(employees)
    .where(
      and(
        inArray(employees.id, ids),
        eq(employees.organizationId, input.organizationId),
      ),
    );

  return new Map(
    rows.map((row) => [
      row.id,
      `${row.preferredName ?? row.firstName} ${row.lastName}`,
    ]),
  );
}

/** Linked user ID to employee name, for screens that record who acted by user. */
export async function findDisplayNamesByUser(
  executor: DatabaseExecutor,
  input: { organizationId: string; userIds: readonly string[] },
): Promise<Map<string, string>> {
  const ids = [...new Set(input.userIds)];

  if (ids.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({
      userId: employees.userId,
      firstName: employees.firstName,
      preferredName: employees.preferredName,
      lastName: employees.lastName,
    })
    .from(employees)
    .where(and(inArray(employees.userId, ids), eq(employees.organizationId, input.organizationId)));

  return new Map(
    rows
      .filter((row) => row.userId !== null)
      .map((row) => [row.userId!, `${row.preferredName ?? row.firstName} ${row.lastName}`]),
  );
}

/**
 * Employee ID to linked user ID, for employees who have a login (Phase 20: notification
 * recipients). Employees without a user are left out.
 */
export async function findLinkedUserIds(
  executor: DatabaseExecutor,
  input: { organizationId: string; employeeIds: readonly string[] },
): Promise<Map<string, string>> {
  const ids = [...new Set(input.employeeIds)];

  if (ids.length === 0) {
    return new Map();
  }

  const rows = await executor
    .select({ id: employees.id, userId: employees.userId })
    .from(employees)
    .where(and(inArray(employees.id, ids), eq(employees.organizationId, input.organizationId)));

  return new Map(rows.flatMap((row) => (row.userId ? [[row.id, row.userId] as const] : [])));
}
