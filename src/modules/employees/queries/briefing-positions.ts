import { and, asc, eq, inArray } from "drizzle-orm";

import { employeePositions, employees, positions } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

// Phase 32 (policy 9, amendment 2): what pre-shift notes need to know about positions. Only
// position identity is read; no wage, status or personal data.

/** The positions the user's own employee holds at this location (active rows only). */
export async function findHeldPositionIds(
  executor: DatabaseExecutor,
  input: { userId: string; organizationId: string; locationId: string },
): Promise<Set<string>> {
  const rows = await executor
    .select({ positionId: employeePositions.positionId })
    .from(employeePositions)
    .innerJoin(employees, eq(employees.id, employeePositions.employeeId))
    .where(
      and(
        eq(employees.userId, input.userId),
        eq(employees.organizationId, input.organizationId),
        eq(employeePositions.locationId, input.locationId),
        eq(employeePositions.active, true),
      ),
    );

  return new Set(rows.map((row) => row.positionId));
}

export type TargetPosition = { id: string; code: string; name: string; active: boolean };

/** Positions a note can be aimed at, or (with `ids`) the named ones, for display. */
export async function findTargetPositions(
  executor: DatabaseExecutor,
  input: { organizationId: string; ids?: readonly string[] },
): Promise<TargetPosition[]> {
  if (input.ids && input.ids.length === 0) {
    return [];
  }

  return executor
    .select({ id: positions.id, code: positions.code, name: positions.name, active: positions.active })
    .from(positions)
    .where(
      and(
        eq(positions.organizationId, input.organizationId),
        input.ids ? inArray(positions.id, [...input.ids]) : undefined,
      ),
    )
    .orderBy(asc(positions.name), asc(positions.code), asc(positions.id));
}
