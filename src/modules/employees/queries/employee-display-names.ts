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
