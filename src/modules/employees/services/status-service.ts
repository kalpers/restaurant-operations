import type { Database } from "@/db";
import { assertVersionMatched } from "@/db/helpers/versioning";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { NotFoundError } from "@/shared/errors/app-error";

import type { EmployeeEmploymentDetail } from "../dto/employee-dto";
import { endAllActiveAssignments } from "../repositories/assignment-repository";
import {
  findEmploymentRow,
  findStatusHistoryRows,
  insertStatusHistory,
  updateEmployeeRow,
  type EmployeeCore,
} from "../repositories/employee-repository";
import {
  assertStatusChangeAllowed,
  assertTerminationDateAllowed,
} from "../rules/employee-rules";
import type { EmploymentStatus } from "../types";
import {
  assertPermission,
  assertVersion,
  lockEmployee,
  requireEmployee,
  todayAtActorLocation,
} from "./access";

/** Status and history are Management-tier data, separate from the general view. */
export async function getEmployeeEmployment(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
): Promise<EmployeeEmploymentDetail> {
  assertPermission(actor, "hr.view");
  await requireEmployee(executor, actor, employeeId);

  const employment = await findEmploymentRow(executor, employeeId);

  if (!employment) {
    throw new NotFoundError("employee");
  }

  return {
    ...employment,
    statusHistory: await findStatusHistoryRows(executor, employeeId),
  };
}

/** Changes the status and appends history together. Termination has its own workflow. */
export async function changeEmployeeStatus(
  database: Database,
  actor: Actor,
  input: {
    employeeId: string;
    status: EmploymentStatus;
    reason: string | null;
    expectedVersion: number;
  },
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "employees.edit");

  return withTransaction(database, async (transaction) => {
    const employee = await lockEmployee(transaction, actor, input.employeeId);

    assertVersion(employee, input.expectedVersion);
    assertStatusChangeAllowed(employee.employmentStatus, input.status);

    const updated = assertVersionMatched(
      await updateEmployeeRow(transaction, employee.id, input.expectedVersion, {
        employmentStatus: input.status,
      }),
      { type: "employee", id: employee.id },
    );

    await insertStatusHistory(transaction, {
      employeeId: employee.id,
      status: input.status,
      reason: input.reason,
      changedByUserId: actor.userId,
    });

    return updated;
  });
}

/**
 * The Employees half of termination, run in the workflow's transaction: sets the status
 * and date, ends all eligibility, appends history. Nothing is deleted, and compensation
 * history is left as it is.
 */
export async function recordTermination(
  transaction: DatabaseTransaction,
  actor: Actor,
  employee: EmployeeCore,
  input: {
    terminationDate: string;
    reason: string | null;
    expectedVersion: number;
  },
): Promise<{ id: string; version: number }> {
  assertTerminationDateAllowed({
    hireDate: employee.hireDate,
    terminationDate: input.terminationDate,
    today: await todayAtActorLocation(transaction, actor),
  });

  await endAllActiveAssignments(
    transaction,
    employee.id,
    input.terminationDate,
  );

  const updated = assertVersionMatched(
    await updateEmployeeRow(transaction, employee.id, input.expectedVersion, {
      employmentStatus: "TERMINATED",
      terminationDate: input.terminationDate,
      primaryLocationId: null,
    }),
    { type: "employee", id: employee.id },
  );

  await insertStatusHistory(transaction, {
    employeeId: employee.id,
    status: "TERMINATED",
    reason: input.reason,
    changedByUserId: actor.userId,
  });

  return updated;
}
