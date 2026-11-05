import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { assertVersionMatched } from "@/db/helpers/versioning";
import {
  withTransaction,
  type DatabaseExecutor,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";

import type {
  EmployeeDirectorySummary,
  EmployeeGeneralDetail,
} from "../dto/employee-dto";
import {
  findLocationAssignments,
  findPositionAssignments,
  insertLocationAssignment,
  insertPositionAssignment,
} from "../repositories/assignment-repository";
import {
  findDirectoryRows,
  findGeneralRow,
  findPrimaryPositionNames,
  insertEmployee,
  insertStatusHistory,
  updateEmployeeRow,
} from "../repositories/employee-repository";
import { findPositionInOrganization } from "../repositories/reference-repository";
import { actorHolds, assertPermission, requireEmployee } from "./access";

/** The list reads no restricted table. Status is removed unless the actor may see it. */
export async function listEmployees(
  executor: DatabaseExecutor,
  actor: Actor,
): Promise<EmployeeDirectorySummary[]> {
  assertPermission(actor, "employees.view");

  const rows = await findDirectoryRows(executor, {
    organizationId: actor.organizationId,
    locationId: actor.locationId,
  });
  const primaryPositions = await findPrimaryPositionNames(
    executor,
    rows.map((row) => row.id),
    actor.locationId,
  );
  const mayViewStatus = actorHolds(actor, "hr.view");

  return rows.map(({ employmentStatus, ...row }) => ({
    ...row,
    primaryPositionName: primaryPositions.get(row.id) ?? null,
    ...(mayViewStatus ? { employmentStatus } : {}),
  }));
}

export async function getEmployeeGeneral(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
): Promise<EmployeeGeneralDetail> {
  assertPermission(actor, "employees.view");

  const employee = await findGeneralRow(executor, employeeId, {
    organizationId: actor.organizationId,
    locationId: actor.locationId,
  });

  if (!employee) {
    throw new NotFoundError("employee");
  }

  const includeEnded = actorHolds(actor, "hr.view");

  return {
    ...employee,
    locations: await findLocationAssignments(executor, employeeId, {
      includeEnded,
    }),
    positions: await findPositionAssignments(executor, employeeId, {
      includeEnded,
    }),
  };
}

export type CreateEmployeeInput = {
  employeeNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  preferredName: string | null;
  workEmail: string | null;
  hireDate: string;
  employmentType: string;
  /** The initial position at the actor's location. Grants no security role. */
  positionId: string | null;
};

/**
 * Creates the employee at the actor's location with their initial status history, in
 * one transaction. It never creates a user: a login is a separate, explicit act.
 */
export async function createEmployee(
  database: Database,
  actor: Actor,
  input: CreateEmployeeInput,
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "employees.create");

  if (input.positionId) {
    assertPermission(actor, "employees.positions.manage");
  }

  const { positionId, ...fields } = input;

  try {
    return await withTransaction(database, async (transaction) => {
      if (positionId) {
        const position = await findPositionInOrganization(
          transaction,
          positionId,
          actor.organizationId,
        );

        if (!position?.active) {
          throw new ValidationError("Choose an active position.");
        }
      }

      const employee = await insertEmployee(transaction, {
        ...fields,
        organizationId: actor.organizationId,
        primaryLocationId: actor.locationId,
      });

      await insertLocationAssignment(transaction, {
        employeeId: employee.id,
        locationId: actor.locationId,
        primaryLocation: true,
        effectiveFrom: input.hireDate,
      });

      if (positionId) {
        await insertPositionAssignment(transaction, {
          employeeId: employee.id,
          positionId,
          locationId: actor.locationId,
          primaryPosition: true,
          effectiveFrom: input.hireDate,
        });
      }

      await insertStatusHistory(transaction, {
        employeeId: employee.id,
        status: "ACTIVE",
        reason: "Employee created",
        changedByUserId: actor.userId,
      });

      return employee;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "EMPLOYEE_NUMBER_EXISTS",
        "An employee with this number already exists.",
      );
    }

    throw error;
  }
}

/** General fields only. Personal contact details have their own permission. */
export async function updateEmployeeGeneral(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
  input: {
    firstName: string;
    middleName: string | null;
    lastName: string;
    preferredName: string | null;
    workEmail: string | null;
    employmentType: string;
    expectedVersion: number;
  },
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "employees.edit");
  await requireEmployee(executor, actor, employeeId);

  const { expectedVersion, ...changes } = input;

  return assertVersionMatched(
    await updateEmployeeRow(executor, employeeId, expectedVersion, changes),
    { type: "employee", id: employeeId },
  );
}
