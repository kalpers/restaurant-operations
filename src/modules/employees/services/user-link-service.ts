import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { assertVersionMatched } from "@/db/helpers/versioning";
import {
  withTransaction,
  type DatabaseExecutor,
} from "@/db/transactions/transaction-context";
import { findLinkableUser } from "@/modules/auth/services/user-service";
import type { Actor } from "@/modules/auth/types";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/shared/errors/app-error";

import type { LinkedUserView } from "../dto/employee-dto";
import {
  findLinkedUserId,
  updateEmployeeRow,
} from "../repositories/employee-repository";
import {
  assertNotTerminated,
  assertPermission,
  assertVersion,
  lockEmployee,
  requireEmployee,
} from "./access";

// A link identifies a person's login. It transfers no permissions: roles stay on the
// user, positions stay on the employee, and neither changes the other.

export async function getLinkedUser(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
): Promise<LinkedUserView> {
  assertPermission(actor, "admin.users.view");
  await requireEmployee(executor, actor, employeeId);

  const userId = await findLinkedUserId(executor, employeeId);

  if (!userId) {
    return null;
  }

  return (
    (await findLinkableUser(executor, userId, actor.organizationId)) ?? null
  );
}

function assertMayManageLink(actor: Actor): void {
  assertPermission(actor, "employees.edit");
  assertPermission(actor, "admin.users.manage");
}

export async function linkUser(
  database: Database,
  actor: Actor,
  input: { employeeId: string; userId: string; expectedVersion: number },
): Promise<{ id: string; version: number }> {
  assertMayManageLink(actor);

  try {
    return await withTransaction(database, async (transaction) => {
      const employee = await lockEmployee(transaction, actor, input.employeeId);

      assertVersion(employee, input.expectedVersion);
      assertNotTerminated(employee);

      if (employee.userId) {
        throw new BusinessRuleError(
          "EMPLOYEE_ALREADY_LINKED",
          "This employee is already linked to a user.",
        );
      }

      const user = await findLinkableUser(
        transaction,
        input.userId,
        actor.organizationId,
      );

      if (!user) {
        throw new NotFoundError("user");
      }

      return assertVersionMatched(
        await updateEmployeeRow(transaction, employee.id, input.expectedVersion, {
          userId: user.id,
        }),
        { type: "employee", id: employee.id },
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "USER_ALREADY_LINKED",
        "This user is already linked to another employee.",
      );
    }

    throw error;
  }
}

/** Allowed after termination: it's how a rehire's login moves to a new record. */
export async function unlinkUser(
  database: Database,
  actor: Actor,
  input: { employeeId: string; expectedVersion: number },
): Promise<{ id: string; version: number }> {
  assertMayManageLink(actor);

  return withTransaction(database, async (transaction) => {
    const employee = await lockEmployee(transaction, actor, input.employeeId);

    assertVersion(employee, input.expectedVersion);

    if (!employee.userId) {
      throw new NotFoundError("user link");
    }

    return assertVersionMatched(
      await updateEmployeeRow(transaction, employee.id, input.expectedVersion, {
        userId: null,
      }),
      { type: "employee", id: employee.id },
    );
  });
}
