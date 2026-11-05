import type {
  DatabaseExecutor,
  DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import {
  AuthorizationError,
  BusinessRuleError,
  NotFoundError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  findEmployeeCore,
  findLocationInOrganization,
  lockEmployeeCore,
  type EmployeeCore,
} from "../repositories/employee-repository";
import { calendarDateIn } from "../rules/employee-rules";

export function actorHolds(actor: Actor, permission: PermissionCode): boolean {
  return actor.permissions.has(permission);
}

/**
 * Every employee service calls this itself, so a restricted query is refused however
 * it is reached, not only through a route.
 */
export function assertPermission(actor: Actor, permission: PermissionCode): void {
  if (!actorHolds(actor, permission)) {
    throw new AuthorizationError();
  }
}

function scopeOf(actor: Actor) {
  return { organizationId: actor.organizationId, locationId: actor.locationId };
}

/**
 * The employee, if the actor's location is one they have worked at. Anything else
 * looks the same as an ID that doesn't exist, including another organization's.
 */
export async function requireEmployee(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
): Promise<EmployeeCore> {
  const employee = await findEmployeeCore(executor, employeeId, scopeOf(actor));

  if (!employee) {
    throw new NotFoundError("employee");
  }

  return employee;
}

/** As `requireEmployee`, holding the row until the transaction ends. */
export async function lockEmployee(
  transaction: DatabaseTransaction,
  actor: Actor,
  employeeId: string,
): Promise<EmployeeCore> {
  const employee = await lockEmployeeCore(
    transaction,
    employeeId,
    scopeOf(actor),
  );

  if (!employee) {
    throw new NotFoundError("employee");
  }

  return employee;
}

export function assertVersion(
  employee: EmployeeCore,
  expectedVersion: number,
): void {
  if (employee.version !== expectedVersion) {
    throw new ConcurrencyError("employee", employee.id);
  }
}

export function assertNotTerminated(employee: EmployeeCore): void {
  if (employee.employmentStatus === "TERMINATED") {
    throw new BusinessRuleError(
      "EMPLOYEE_TERMINATED",
      "A terminated employee can't be changed.",
    );
  }
}

/** Today's calendar date at the actor's location. */
export async function todayAtActorLocation(
  executor: DatabaseExecutor,
  actor: Actor,
): Promise<string> {
  const location = await findLocationInOrganization(
    executor,
    actor.locationId,
    actor.organizationId,
  );

  if (!location) {
    throw new NotFoundError("location");
  }

  return calendarDateIn(location.timezone);
}
