import type { Database } from "@/db";
import { isExclusionViolation } from "@/db/helpers/database-errors";
import {
  withTransaction,
  type DatabaseExecutor,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/shared/errors/app-error";

import type { EmployeePositionCompensationHistory } from "../dto/employee-dto";
import { hasPositionEffectiveOn } from "../repositories/assignment-repository";
import {
  closeCompensationPeriod,
  findCompensationHistoryRows,
  findOpenCompensationPeriod,
  insertCompensationPeriod,
} from "../repositories/compensation-repository";
import { findPositionInOrganization } from "../repositories/reference-repository";
import {
  assertCompensationAmounts,
  previousDay,
} from "../rules/employee-rules";
import type { CompensationType } from "../types";
import {
  assertNotTerminated,
  assertPermission,
  lockEmployee,
  requireEmployee,
} from "./access";

export async function getCompensationHistory(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
): Promise<EmployeePositionCompensationHistory> {
  assertPermission(actor, "hr.compensation.view");
  await requireEmployee(executor, actor, employeeId);

  return findCompensationHistoryRows(executor, employeeId);
}

/**
 * Starts a new wage for one Employee + Position and closes that pair's open period the
 * day before, in one transaction. Other positions' wages are never touched, and an old
 * amount is never overwritten. This is HR history, not payroll.
 */
export async function changeCompensation(
  database: Database,
  actor: Actor,
  input: {
    employeeId: string;
    positionId: string;
    compensationType: CompensationType;
    hourlyRate: string | null;
    annualSalary: string | null;
    effectiveFrom: string;
    changeReason: string | null;
  },
) {
  assertPermission(actor, "hr.compensation.edit");
  assertCompensationAmounts(input);

  try {
    return await withTransaction(database, async (transaction) => {
      const employee = await lockEmployee(transaction, actor, input.employeeId);

      assertNotTerminated(employee);

      if (
        !(await findPositionInOrganization(
          transaction,
          input.positionId,
          actor.organizationId,
        ))
      ) {
        throw new NotFoundError("position");
      }

      if (
        !(await hasPositionEffectiveOn(transaction, {
          employeeId: employee.id,
          positionId: input.positionId,
          date: input.effectiveFrom,
        }))
      ) {
        throw new BusinessRuleError(
          "POSITION_NOT_ASSIGNED",
          "The employee must hold this position on the date the wage takes effect.",
        );
      }

      const open = await findOpenCompensationPeriod(
        transaction,
        employee.id,
        input.positionId,
      );

      if (open) {
        if (input.effectiveFrom <= open.effectiveFrom) {
          throw new ConflictError(
            "COMPENSATION_OVERLAP",
            "A new wage must start after the current wage's start date.",
          );
        }

        await closeCompensationPeriod(
          transaction,
          open.id,
          previousDay(input.effectiveFrom),
        );
      }

      return insertCompensationPeriod(transaction, {
        organizationId: actor.organizationId,
        employeeId: employee.id,
        positionId: input.positionId,
        compensationType: input.compensationType,
        hourlyRate: input.hourlyRate,
        annualSalary: input.annualSalary,
        effectiveFrom: input.effectiveFrom,
        changeReason: input.changeReason,
        createdByUserId: actor.userId,
      });
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new ConflictError(
        "COMPENSATION_OVERLAP",
        "This overlaps an existing wage period for this position.",
      );
    }

    throw error;
  }
}
