import type {
  DatabaseExecutor,
  DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { findLinkedEmployeeId } from "@/modules/employees/queries/scheduling-facts";
import {
  AuthorizationError,
  BusinessRuleError,
  NotFoundError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { findPeriod, lockPeriod, type PeriodRow } from "../repositories/schedule-repository";

export function actorHolds(actor: Actor, permission: PermissionCode): boolean {
  return actor.permissions.has(permission);
}

/** Every service calls this itself, so a request is refused however it's reached. */
export function assertPermission(actor: Actor, permission: PermissionCode): void {
  if (!actorHolds(actor, permission)) {
    throw new AuthorizationError();
  }
}

/** Drafts, coverage and explanations are for people who work on schedules. */
export function canReviewSchedules(actor: Actor): boolean {
  return (
    actorHolds(actor, "schedule.edit") ||
    actorHolds(actor, "schedule.generate") ||
    actorHolds(actor, "schedule.publish")
  );
}

export function assertCanReview(actor: Actor): void {
  if (!canReviewSchedules(actor)) {
    throw new AuthorizationError();
  }
}

/** A draft looks absent to someone who can't review schedules. */
export async function requireVisiblePeriod(
  executor: DatabaseExecutor,
  actor: Actor,
  periodId: string,
): Promise<PeriodRow> {
  const period = await findPeriod(executor, periodId, actor.locationId);

  if (!period || (period.status === "DRAFT" && !canReviewSchedules(actor))) {
    throw new NotFoundError("schedule period");
  }

  return period;
}

/** The row, locked, at the expected version and still a draft. */
export async function lockEditableDraft(
  transaction: DatabaseTransaction,
  actor: Actor,
  periodId: string,
  expectedVersion: number,
): Promise<PeriodRow> {
  const period = await lockPeriod(transaction, periodId, actor.locationId);

  if (!period) {
    throw new NotFoundError("schedule period");
  }

  if (period.version !== expectedVersion) {
    throw new ConcurrencyError("schedule period", period.id);
  }

  if (period.status !== "DRAFT") {
    throw new BusinessRuleError(
      "SCHEDULE_NOT_DRAFT",
      "Only a draft schedule can be edited. Published assignments change through a shift swap.",
    );
  }

  return period;
}

/**
 * The employee linked to the signed-in user, resolved on the server. Self-service takes
 * no employee ID from the request, so nobody can act as someone else.
 */
export async function resolveSelfEmployeeId(
  executor: DatabaseExecutor,
  actor: Actor,
): Promise<string> {
  const employeeId = await findLinkedEmployeeId(executor, {
    userId: actor.userId,
    organizationId: actor.organizationId,
  });

  if (!employeeId) {
    throw new BusinessRuleError(
      "NO_LINKED_EMPLOYEE",
      "Your login isn't linked to an employee record.",
    );
  }

  return employeeId;
}
