import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { employeePositionCompensation, positions } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

const compensation = employeePositionCompensation;

/** Restricted. Only the compensation service calls this. */
export function findCompensationHistoryRows(
  executor: DatabaseExecutor,
  employeeId: string,
) {
  return executor
    .select({
      id: compensation.id,
      positionId: compensation.positionId,
      positionName: positions.name,
      compensationType: compensation.compensationType,
      hourlyRate: compensation.hourlyRate,
      annualSalary: compensation.annualSalary,
      effectiveFrom: compensation.effectiveFrom,
      effectiveTo: compensation.effectiveTo,
      changeReason: compensation.changeReason,
    })
    .from(compensation)
    .innerJoin(positions, eq(positions.id, compensation.positionId))
    .where(eq(compensation.employeeId, employeeId))
    .orderBy(asc(positions.name), desc(compensation.effectiveFrom));
}

export async function findOpenCompensationPeriod(
  executor: DatabaseExecutor,
  employeeId: string,
  positionId: string,
) {
  const [period] = await executor
    .select({
      id: compensation.id,
      effectiveFrom: compensation.effectiveFrom,
    })
    .from(compensation)
    .where(
      and(
        eq(compensation.employeeId, employeeId),
        eq(compensation.positionId, positionId),
        isNull(compensation.effectiveTo),
      ),
    );

  return period;
}

/** The only update this table allows: a wage change never edits an amount. */
export async function closeCompensationPeriod(
  executor: DatabaseExecutor,
  periodId: string,
  effectiveTo: string,
): Promise<void> {
  await executor
    .update(compensation)
    .set({ effectiveTo })
    .where(eq(compensation.id, periodId));
}

export async function insertCompensationPeriod(
  executor: DatabaseExecutor,
  values: {
    organizationId: string;
    employeeId: string;
    positionId: string;
    compensationType: string;
    hourlyRate: string | null;
    annualSalary: string | null;
    effectiveFrom: string;
    changeReason: string | null;
    createdByUserId: string;
  },
) {
  const [period] = await executor
    .insert(compensation)
    .values(values)
    .returning({
      id: compensation.id,
      positionId: compensation.positionId,
      compensationType: compensation.compensationType,
      hourlyRate: compensation.hourlyRate,
      annualSalary: compensation.annualSalary,
      effectiveFrom: compensation.effectiveFrom,
      effectiveTo: compensation.effectiveTo,
    });

  if (!period) {
    throw new Error("Compensation insert returned no row.");
  }

  return period;
}
