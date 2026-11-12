import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { assertVersionMatched } from "@/db/helpers/versioning";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import {
  findSchedulingFacts,
  lockEmployeesForScheduling,
} from "@/modules/employees/queries/scheduling-facts";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";

import {
  findPeriodStatus,
  findSwap,
  findSwapsAtLocation,
  findSwapsForEmployee,
  insertSwap,
  updateSwapRow,
  type SwapRow,
} from "../repositories/request-repository";
import {
  endAssignmentRow,
  findAssignmentWithShift,
  findShiftAtLocation,
  insertAssignment,
  lockPeriod,
  updatePeriodRow,
} from "../repositories/schedule-repository";
import { assertPermission, resolveSelfEmployeeId } from "./access";
import { assertEmployeeEligible } from "./schedule-service";
import { notifyShiftSwapped } from "./schedule-notifications";

// The only way a published assignment changes. PENDING -> ACCEPTED -> COMPLETED, with
// DENIED and CANCELLED. A holder of schedule.swap.approve can open a swap or record
// acceptance for an employee, because someone with no login, or who has left, can't.
// Whoever acts, the receiving employee faces the same eligibility rules as manual assignment.

async function requireSwappableAssignment(
  executor: DatabaseExecutor,
  actor: Actor,
  assignmentId: string,
) {
  const assignment = await findAssignmentWithShift(
    executor,
    assignmentId,
    actor.locationId,
  );

  if (!assignment || assignment.status !== "ACTIVE") {
    throw new NotFoundError("shift assignment");
  }

  if ((await findPeriodStatus(executor, assignment.periodId)) !== "PUBLISHED") {
    throw new BusinessRuleError(
      "SWAP_REQUIRES_PUBLISHED",
      "Only a shift on a published schedule can be swapped.",
    );
  }

  if (assignment.startAt <= new Date()) {
    throw new BusinessRuleError(
      "SHIFT_ALREADY_STARTED",
      "A shift that has started can't be swapped.",
    );
  }

  return assignment;
}

async function assertTargetInOrganization(
  executor: DatabaseExecutor,
  actor: Actor,
  targetEmployeeId: string | null,
  requestingEmployeeId: string,
): Promise<void> {
  if (targetEmployeeId === null) {
    return;
  }

  if (targetEmployeeId === requestingEmployeeId) {
    throw new ValidationError("Choose someone else to take this shift.");
  }

  const [target] = await findSchedulingFacts(executor, {
    organizationId: actor.organizationId,
    locationId: actor.locationId,
    employeeIds: [targetEmployeeId],
  });

  if (!target) {
    throw new NotFoundError("employee");
  }
}

async function openSwap(
  database: Database,
  actor: Actor,
  assignment: { id: string; employeeId: string },
  input: { targetEmployeeId: string | null; reason: string | null },
) {
  await assertTargetInOrganization(
    database,
    actor,
    input.targetEmployeeId,
    assignment.employeeId,
  );

  try {
    return await insertSwap(database, {
      shiftAssignmentId: assignment.id,
      requestingEmployeeId: assignment.employeeId,
      targetEmployeeId: input.targetEmployeeId,
      reason: input.reason,
      requestedByUserId: actor.userId,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "SWAP_ALREADY_OPEN",
        "This assignment already has an open swap request.",
      );
    }

    throw error;
  }
}

/** The requester comes from the login, and must hold the assignment. */
export async function requestOwnSwap(
  database: Database,
  actor: Actor,
  input: {
    assignmentId: string;
    targetEmployeeId: string | null;
    reason: string | null;
  },
) {
  assertPermission(actor, "schedule.swap.request");

  const self = await resolveSelfEmployeeId(database, actor);
  const assignment = await requireSwappableAssignment(
    database,
    actor,
    input.assignmentId,
  );

  if (assignment.employeeId !== self) {
    throw new NotFoundError("shift assignment");
  }

  return openSwap(database, actor, assignment, input);
}

/** For a manager, on behalf of whoever holds the assignment. */
export async function openSwapForEmployee(
  database: Database,
  actor: Actor,
  input: {
    assignmentId: string;
    targetEmployeeId: string | null;
    reason: string | null;
  },
) {
  assertPermission(actor, "schedule.swap.approve");

  const assignment = await requireSwappableAssignment(
    database,
    actor,
    input.assignmentId,
  );

  return openSwap(database, actor, assignment, input);
}

export async function listOwnSwaps(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "schedule.swap.request");

  const self = await resolveSelfEmployeeId(executor, actor);
  const swaps = await findSwapsForEmployee(executor, self);

  return { employeeId: self, swaps: await withNames(executor, actor, swaps) };
}

async function withNames(
  executor: DatabaseExecutor,
  actor: Actor,
  swaps: readonly SwapRow[],
) {
  const facts = await findSchedulingFacts(executor, {
    organizationId: actor.organizationId,
    employeeIds: [
      ...new Set(
        swaps.flatMap((swap) => [
          swap.requestingEmployeeId,
          ...(swap.targetEmployeeId ? [swap.targetEmployeeId] : []),
        ]),
      ),
    ],
  });
  const names = new Map(facts.map((row) => [row.id, row.displayName]));

  return swaps.map((swap) => ({
    ...swap,
    requesterName: names.get(swap.requestingEmployeeId) ?? "Unknown",
    targetName: swap.targetEmployeeId
      ? (names.get(swap.targetEmployeeId) ?? "Unknown")
      : null,
  }));
}

export async function listSwapsForReview(
  executor: DatabaseExecutor,
  actor: Actor,
) {
  assertPermission(actor, "schedule.swap.approve");

  return withNames(
    executor,
    actor,
    await findSwapsAtLocation(executor, actor.locationId),
  );
}

async function requireSwap(
  executor: DatabaseExecutor,
  actor: Actor,
  swapId: string,
): Promise<SwapRow> {
  const swap = await findSwap(executor, swapId, actor.locationId);

  if (!swap) {
    throw new NotFoundError("swap request");
  }

  return swap;
}

function assertOpen(swap: SwapRow): void {
  if (swap.status !== "PENDING" && swap.status !== "ACCEPTED") {
    throw new BusinessRuleError(
      "SWAP_NOT_OPEN",
      "This swap request is already closed.",
    );
  }
}

/** A manager names who should take a shift, or changes it, before acceptance. */
export async function setSwapTarget(
  database: Database,
  actor: Actor,
  swapId: string,
  input: { targetEmployeeId: string; expectedVersion: number },
) {
  assertPermission(actor, "schedule.swap.approve");

  const swap = await requireSwap(database, actor, swapId);

  if (swap.status !== "PENDING") {
    throw new BusinessRuleError(
      "SWAP_NOT_PENDING",
      "The target can't change after the swap has been accepted.",
    );
  }

  await assertTargetInOrganization(
    database,
    actor,
    input.targetEmployeeId,
    swap.requestingEmployeeId,
  );

  return assertVersionMatched(
    await updateSwapRow(database, swapId, input.expectedVersion, {
      targetEmployeeId: input.targetEmployeeId,
    }),
    { type: "swap request", id: swapId },
  );
}

async function acceptSwap(
  database: DatabaseTransaction,
  actor: Actor,
  swap: SwapRow,
  expectedVersion: number,
) {
  if (swap.status !== "PENDING") {
    throw new BusinessRuleError(
      "SWAP_NOT_PENDING",
      "Only a pending swap can be accepted.",
    );
  }

  if (!swap.targetEmployeeId) {
    throw new BusinessRuleError(
      "SWAP_HAS_NO_TARGET",
      "This swap needs someone named to take the shift first.",
    );
  }

  const shift = await findShiftAtLocation(database, swap.shiftId, swap.locationId);

  if (!shift) {
    throw new NotFoundError("shift");
  }

  await assertEmployeeEligible(database, actor, swap.targetEmployeeId, shift);

  const accepted = assertVersionMatched(
    await updateSwapRow(database, swap.id, expectedVersion, {
      status: "ACCEPTED",
      acceptedAt: new Date(),
      acceptedByUserId: actor.userId,
    }),
    { type: "swap request", id: swap.id },
  );

  await recordAudit(database, actor, {
    action: "scheduling.swap-accepted",
    entityId: swap.id,
    before: { status: swap.status },
    after: { status: "ACCEPTED", shiftId: swap.shiftId, acceptingEmployeeId: swap.targetEmployeeId },
  });

  return accepted;
}

/** The target accepts for themselves. Their identity comes from the login. */
export async function acceptOwnSwap(
  database: Database,
  actor: Actor,
  swapId: string,
  input: { expectedVersion: number },
) {
  assertPermission(actor, "schedule.swap.request");

  return withTransaction(database, async (transaction) => {
    const self = await resolveSelfEmployeeId(transaction, actor);
    const swap = await requireSwap(transaction, actor, swapId);

    if (swap.targetEmployeeId !== self) {
      throw new NotFoundError("swap request");
    }

    return acceptSwap(transaction, actor, swap, input.expectedVersion);
  });
}

/** For a target who has no login or isn't able to accept themselves. */
export async function recordSwapAcceptance(
  database: Database,
  actor: Actor,
  swapId: string,
  input: { expectedVersion: number },
) {
  assertPermission(actor, "schedule.swap.approve");

  return withTransaction(database, async (transaction) => {
    const swap = await requireSwap(transaction, actor, swapId);

    return acceptSwap(transaction, actor, swap, input.expectedVersion);
  });
}

/**
 * Completes the swap in one transaction: revalidates the receiving employee, ends the
 * original assignment as SWAPPED, creates a SHIFT_SWAP assignment and records who approved.
 * A failure leaves the original assignment untouched.
 */
export async function approveSwap(
  database: Database,
  actor: Actor,
  swapId: string,
  input: { expectedVersion: number },
) {
  assertPermission(actor, "schedule.swap.approve");

  return withTransaction(database, async (transaction) => {
    const swap = await requireSwap(transaction, actor, swapId);

    if (swap.status !== "ACCEPTED" || !swap.targetEmployeeId) {
      throw new BusinessRuleError(
        "SWAP_NOT_ACCEPTED",
        "The receiving employee must accept before this can be approved.",
      );
    }

    const period = await lockPeriod(
      transaction,
      swap.periodId,
      actor.locationId,
    );

    if (period?.status !== "PUBLISHED") {
      throw new BusinessRuleError(
        "SWAP_REQUIRES_PUBLISHED",
        "Only a shift on a published schedule can be swapped.",
      );
    }

    await lockEmployeesForScheduling(transaction, [
      swap.requestingEmployeeId,
      swap.targetEmployeeId,
    ]);

    const shift = await findShiftAtLocation(
      transaction,
      swap.shiftId,
      actor.locationId,
    );
    const assignment = await findAssignmentWithShift(
      transaction,
      swap.shiftAssignmentId,
      actor.locationId,
    );

    if (!shift || assignment?.status !== "ACTIVE") {
      throw new BusinessRuleError(
        "SWAP_ASSIGNMENT_ENDED",
        "The original assignment is no longer active.",
      );
    }

    await assertEmployeeEligible(
      transaction,
      actor,
      swap.targetEmployeeId,
      shift,
    );
    await endAssignmentRow(transaction, swap.shiftAssignmentId, {
      status: "SWAPPED",
      endedByUserId: actor.userId,
    });

    const replacement = await insertAssignment(transaction, {
      shiftId: shift.id,
      employeeId: swap.targetEmployeeId,
      assignmentSource: "SHIFT_SWAP",
      assignedByUserId: actor.userId,
    });
    const updated = assertVersionMatched(
      await updateSwapRow(transaction, swapId, input.expectedVersion, {
        status: "COMPLETED",
        approvedByUserId: actor.userId,
        approvedAt: new Date(),
        replacementAssignmentId: replacement.id,
      }),
      { type: "swap request", id: swapId },
    );

    // Anything prepared against the previous state of this schedule is now stale.
    await updatePeriodRow(transaction, swap.periodId);
    // Phase 20 (policy 13): both employees hear about the change.
    await notifyShiftSwapped(
      transaction,
      actor,
      { id: swapId, requestingEmployeeId: swap.requestingEmployeeId, targetEmployeeId: swap.targetEmployeeId },
      shift,
    );
    await recordAudit(transaction, actor, {
      action: "scheduling.swap-approved",
      entityId: swapId,
      before: { status: swap.status },
      after: {
        status: "COMPLETED",
        shiftId: shift.id,
        requestingEmployeeId: swap.requestingEmployeeId,
        acceptingEmployeeId: swap.targetEmployeeId,
      },
    });

    return updated;
  });
}

export async function denySwap(
  database: Database,
  actor: Actor,
  swapId: string,
  input: { expectedVersion: number },
) {
  assertPermission(actor, "schedule.swap.approve");

  return withTransaction(database, async (transaction) => {
    const swap = await requireSwap(transaction, actor, swapId);

    assertOpen(swap);

    const denied = assertVersionMatched(
      await updateSwapRow(transaction, swapId, input.expectedVersion, {
        status: "DENIED",
        deniedByUserId: actor.userId,
        deniedAt: new Date(),
      }),
      { type: "swap request", id: swapId },
    );

    await recordAudit(transaction, actor, {
      action: "scheduling.swap-denied",
      entityId: swapId,
      before: { status: swap.status },
      after: { status: "DENIED", shiftId: swap.shiftId },
    });

    return denied;
  });
}

/** The requester can withdraw their own. A manager uses deny. */
export async function cancelOwnSwap(
  database: Database,
  actor: Actor,
  swapId: string,
  input: { expectedVersion: number },
) {
  assertPermission(actor, "schedule.swap.request");

  const self = await resolveSelfEmployeeId(database, actor);
  const swap = await requireSwap(database, actor, swapId);

  if (swap.requestingEmployeeId !== self) {
    throw new NotFoundError("swap request");
  }

  assertOpen(swap);

  return assertVersionMatched(
    await updateSwapRow(database, swapId, input.expectedVersion, {
      status: "CANCELLED",
    }),
    { type: "swap request", id: swapId },
  );
}
