import type { Database } from "@/db";
import { assertVersionMatched } from "@/db/helpers/versioning";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  findSchedulingFacts,
  lockEmployeesForScheduling,
} from "@/modules/employees/queries/scheduling-facts";
import { requireEmployee } from "@/modules/employees/services/access";
import { getLocationTimeZone } from "@/modules/organization/services/organization-service";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";
import { addDays, localDateOf, localToInstantLenient } from "@/shared/time/zoned-time";

import { findAssignmentConflicts } from "../repositories/employee-input-repository";
import {
  findOwnTimeOff,
  findTimeOff,
  findTimeOffAtLocation,
  insertTimeOff,
  updateTimeOffRow,
} from "../repositories/request-repository";
import type { TimeOffType } from "../types";
import { actorHolds, assertPermission, resolveSelfEmployeeId } from "./access";
import { notifyTimeOffDecided } from "./schedule-notifications";
import { loadLocationContext } from "./scheduling-input";

export type TimeOffInput = {
  startDate: string;
  startTime: string | null;
  endDate: string;
  endTime: string | null;
  requestType: TimeOffType;
  reason: string | null;
  employeeNote: string | null;
};

/** Without an end time, the request runs through the whole end date. */
async function resolveSpan(
  executor: DatabaseExecutor,
  actor: Actor,
  input: TimeOffInput,
): Promise<{ startAt: Date; endAt: Date }> {
  const { timeZone } = await loadLocationContext(executor, actor);
  const startAt = localToInstantLenient(
    input.startDate,
    input.startTime ?? "00:00",
    timeZone,
  );
  const endAt = input.endTime
    ? localToInstantLenient(input.endDate, input.endTime, timeZone)
    : localToInstantLenient(addDays(input.endDate, 1), "00:00", timeZone);

  if (endAt <= startAt) {
    throw new ValidationError("The end of the request must be after its start.");
  }

  return { startAt, endAt };
}

async function createRequest(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
  input: TimeOffInput,
) {
  return insertTimeOff(executor, {
    ...(await resolveSpan(executor, actor, input)),
    employeeId,
    requestType: input.requestType,
    reason: input.reason,
    employeeNote: input.employeeNote,
    requestedByUserId: actor.userId,
  });
}

/** The employee comes from the login, never from the request. */
export async function requestOwnTimeOff(
  database: Database,
  actor: Actor,
  input: TimeOffInput,
) {
  assertPermission(actor, "schedule.time-off.request");

  return createRequest(
    database,
    actor,
    await resolveSelfEmployeeId(database, actor),
    input,
  );
}

/** For managers, including on behalf of someone who has no login. */
export async function requestTimeOffForEmployee(
  database: Database,
  actor: Actor,
  employeeId: string,
  input: TimeOffInput,
) {
  assertPermission(actor, "schedule.time-off.approve");

  const employee = await requireEmployee(database, actor, employeeId);

  return createRequest(database, actor, employee.id, input);
}

export async function listOwnTimeOff(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "schedule.time-off.request");

  return findOwnTimeOff(executor, await resolveSelfEmployeeId(executor, actor));
}

/** The review queue, showing each pending request's conflicts before any decision. */
export async function listTimeOffForReview(
  executor: DatabaseExecutor,
  actor: Actor,
) {
  assertPermission(actor, "schedule.time-off.approve");

  const requests = await findTimeOffAtLocation(executor, actor.locationId);
  const facts = await findSchedulingFacts(executor, {
    organizationId: actor.organizationId,
    employeeIds: [...new Set(requests.map((row) => row.employeeId))],
  });
  const names = new Map(facts.map((row) => [row.id, row.displayName]));

  return Promise.all(
    requests.map(async (request) => ({
      ...request,
      employeeName: names.get(request.employeeId) ?? "Unknown",
      conflicts:
        request.status === "PENDING"
          ? await findAssignmentConflicts(executor, request.employeeId, request)
          : [],
    })),
  );
}

async function requireReviewable(
  executor: DatabaseExecutor,
  actor: Actor,
  requestId: string,
) {
  const request = await findTimeOff(executor, requestId);

  if (!request) {
    throw new NotFoundError("time-off request");
  }

  // Looks absent unless the employee has worked at the actor's location.
  await requireEmployee(executor, actor, request.employeeId);

  return request;
}

function assertPending(status: string): void {
  if (status !== "PENDING") {
    throw new BusinessRuleError(
      "TIME_OFF_NOT_PENDING",
      "Only a pending request can be reviewed.",
    );
  }
}

/**
 * Refused while conflicting assignments remain, whichever location they're at. Nothing is
 * removed for the manager: draft assignments are edited, published ones go through a swap.
 */
export async function approveTimeOff(
  database: Database,
  actor: Actor,
  requestId: string,
  input: { managerNote: string | null; expectedVersion: number },
) {
  assertPermission(actor, "schedule.time-off.approve");

  return withTransaction(database, async (transaction) => {
    const request = await requireReviewable(transaction, actor, requestId);

    assertPending(request.status);
    await lockEmployeesForScheduling(transaction, [request.employeeId]);

    const conflicts = await findAssignmentConflicts(
      transaction,
      request.employeeId,
      request,
    );

    if (conflicts.length > 0) {
      throw new ConflictError(
        "TIME_OFF_ASSIGNMENT_CONFLICT",
        `This request conflicts with ${conflicts.length} assigned shift(s): ${conflicts
          .map((row) => `${row.shiftDate} ${row.positionName} (${row.periodName})`)
          .join(", ")}. Resolve them first.`,
      );
    }

    const updated = assertVersionMatched(
      await updateTimeOffRow(transaction, requestId, input.expectedVersion, {
        status: "APPROVED",
        managerNote: input.managerNote,
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
      }),
      { type: "time-off request", id: requestId },
    );

    await notifyDecision(transaction, actor, request, "APPROVED");

    return updated;
  });
}

/** Phase 20 (policy 13): the requester hears the decision, by local dates at the location. */
async function notifyDecision(
  transaction: DatabaseTransaction,
  actor: Actor,
  request: { id: string; employeeId: string; startAt: Date; endAt: Date },
  status: "APPROVED" | "DENIED",
) {
  const timeZone = await getLocationTimeZone(transaction, actor.locationId);
  // The end is exclusive, so the last day off is the one just before it.
  const lastInstant = new Date(Math.max(request.startAt.getTime(), request.endAt.getTime() - 1));

  await notifyTimeOffDecided(transaction, actor, request, status, {
    from: localDateOf(request.startAt, timeZone),
    to: localDateOf(lastInstant, timeZone),
  });
}

export async function denyTimeOff(
  database: Database,
  actor: Actor,
  requestId: string,
  input: { managerNote: string | null; expectedVersion: number },
) {
  assertPermission(actor, "schedule.time-off.approve");

  return withTransaction(database, async (transaction) => {
    const request = await requireReviewable(transaction, actor, requestId);

    assertPending(request.status);

    const updated = assertVersionMatched(
      await updateTimeOffRow(transaction, requestId, input.expectedVersion, {
        status: "DENIED",
        managerNote: input.managerNote,
        reviewedByUserId: actor.userId,
        reviewedAt: new Date(),
      }),
      { type: "time-off request", id: requestId },
    );

    await notifyDecision(transaction, actor, request, "DENIED");

    return updated;
  });
}

/** The requester can cancel their own; someone who reviews requests can cancel any here. */
export async function cancelTimeOff(
  database: Database,
  actor: Actor,
  requestId: string,
  input: { expectedVersion: number },
) {
  const reviewer = actorHolds(actor, "schedule.time-off.approve");

  if (!reviewer) {
    assertPermission(actor, "schedule.time-off.request");
  }

  const request = await findTimeOff(database, requestId);

  if (!request) {
    throw new NotFoundError("time-off request");
  }

  if (reviewer) {
    await requireEmployee(database, actor, request.employeeId);
  } else {
    const self = await resolveSelfEmployeeId(database, actor);

    if (self !== request.employeeId) {
      throw new NotFoundError("time-off request");
    }
  }

  if (request.status !== "PENDING" && request.status !== "APPROVED") {
    throw new BusinessRuleError(
      "TIME_OFF_NOT_CANCELLABLE",
      "Only a pending or approved request can be cancelled.",
    );
  }

  return assertVersionMatched(
    await updateTimeOffRow(database, requestId, input.expectedVersion, {
      status: "CANCELLED",
    }),
    { type: "time-off request", id: requestId },
  );
}
