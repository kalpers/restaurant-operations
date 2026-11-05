import type { Database } from "@/db";
import { isExclusionViolation } from "@/db/helpers/database-errors";
import { assertVersionMatched } from "@/db/helpers/versioning";
import {
  withTransaction,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import {
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";

import {
  clearPrimaryLocation,
  clearPrimaryPositionAt,
  endLocationAssignmentRow,
  endPositionAssignmentRow,
  findActiveLocationAssignmentAt,
  findLocationAssignmentById,
  findPositionAssignmentById,
  hasActivePositionsAtLocation,
  insertLocationAssignment,
  insertPositionAssignment,
  setPrimaryLocationRow,
  setPrimaryPositionRow,
} from "../repositories/assignment-repository";
import {
  findLocationInOrganization,
  updateEmployeeRow,
  type EmployeeCore,
} from "../repositories/employee-repository";
import { findPositionInOrganization } from "../repositories/reference-repository";
import { assertEndDateAllowed } from "../rules/employee-rules";
import {
  assertNotTerminated,
  assertPermission,
  assertVersion,
  lockEmployee,
  todayAtActorLocation,
} from "./access";

// Security roles are never read or changed here: an assignment grants no permissions.

/** Every assignment change takes an expected employee version and advances it. */
async function advanceVersion(
  transaction: DatabaseTransaction,
  employee: EmployeeCore,
  expectedVersion: number,
  changes: { primaryLocationId?: string } = {},
) {
  return assertVersionMatched(
    await updateEmployeeRow(transaction, employee.id, expectedVersion, changes),
    { type: "employee", id: employee.id },
  );
}

/**
 * The employee is reached through the actor's current location, but the change lands
 * at the target, so the actor must hold the permission at both.
 */
function assertTargetAuthority(
  actor: Actor,
  targetActor: Actor,
  permission: PermissionCode,
): void {
  if (
    targetActor.userId !== actor.userId ||
    targetActor.organizationId !== actor.organizationId ||
    !targetActor.permissions.has(permission)
  ) {
    throw new AuthorizationError();
  }
}

function assertNotBeforeHire(employee: EmployeeCore, effectiveFrom: string): void {
  if (effectiveFrom < employee.hireDate) {
    throw new BusinessRuleError(
      "ASSIGNMENT_BEFORE_HIRE",
      "An assignment can't start before the hire date.",
    );
  }
}

async function mapOverlap<Result>(
  operation: () => Promise<Result>,
  message: string,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new ConflictError("ASSIGNMENT_OVERLAP", message);
    }

    throw error;
  }
}

/** `targetActor` is the same user resolved at the location being assigned. */
export async function assignLocation(
  database: Database,
  actor: Actor,
  targetActor: Actor,
  input: { employeeId: string; effectiveFrom: string; expectedVersion: number },
) {
  const permission = "employees.locations.manage";

  assertPermission(actor, permission);
  assertTargetAuthority(actor, targetActor, permission);

  return mapOverlap(
    () =>
      withTransaction(database, async (transaction) => {
        const employee = await lockEmployee(
          transaction,
          actor,
          input.employeeId,
        );

        assertVersion(employee, input.expectedVersion);
        assertNotTerminated(employee);
        assertNotBeforeHire(employee, input.effectiveFrom);

        const location = await findLocationInOrganization(
          transaction,
          targetActor.locationId,
          actor.organizationId,
        );

        if (!location?.active) {
          throw new NotFoundError("location");
        }

        const assignment = await insertLocationAssignment(transaction, {
          employeeId: employee.id,
          locationId: location.id,
          primaryLocation: false,
          effectiveFrom: input.effectiveFrom,
        });

        await advanceVersion(transaction, employee, input.expectedVersion);

        return assignment;
      }),
    "The employee is already assigned to this location for those dates.",
  );
}

/** The row is kept. A primary location, or one with active positions, must change first. */
export async function endLocationAssignment(
  database: Database,
  actor: Actor,
  input: {
    employeeId: string;
    assignmentId: string;
    effectiveTo: string;
    expectedVersion: number;
  },
): Promise<void> {
  assertPermission(actor, "employees.locations.manage");

  await withTransaction(database, async (transaction) => {
    const employee = await lockEmployee(transaction, actor, input.employeeId);

    assertVersion(employee, input.expectedVersion);
    assertNotTerminated(employee);

    const assignment = await findLocationAssignmentById(
      transaction,
      employee.id,
      input.assignmentId,
    );

    if (!assignment?.active) {
      throw new NotFoundError("location assignment");
    }

    if (assignment.primaryLocation) {
      throw new BusinessRuleError(
        "PRIMARY_LOCATION_REQUIRED",
        "Choose another primary location before ending this one.",
      );
    }

    if (
      await hasActivePositionsAtLocation(
        transaction,
        employee.id,
        assignment.locationId,
      )
    ) {
      throw new BusinessRuleError(
        "LOCATION_HAS_ACTIVE_POSITIONS",
        "End the employee's positions at this location first.",
      );
    }

    assertEndDateAllowed({
      from: assignment.effectiveFrom,
      to: input.effectiveTo,
      today: await todayAtActorLocation(transaction, actor),
    });

    await endLocationAssignmentRow(
      transaction,
      assignment.id,
      input.effectiveTo,
    );
    await advanceVersion(transaction, employee, input.expectedVersion);
  });
}

/** Moves the primary flag and `employees.primary_location_id` together. */
export async function setPrimaryLocation(
  database: Database,
  actor: Actor,
  input: {
    employeeId: string;
    assignmentId: string;
    expectedVersion: number;
  },
): Promise<void> {
  assertPermission(actor, "employees.locations.manage");

  await withTransaction(database, async (transaction) => {
    const employee = await lockEmployee(transaction, actor, input.employeeId);

    assertVersion(employee, input.expectedVersion);
    assertNotTerminated(employee);

    const assignment = await findLocationAssignmentById(
      transaction,
      employee.id,
      input.assignmentId,
    );

    if (!assignment?.active) {
      throw new NotFoundError("location assignment");
    }

    await clearPrimaryLocation(transaction, employee.id);
    await setPrimaryLocationRow(transaction, assignment.id);
    await advanceVersion(transaction, employee, input.expectedVersion, {
      primaryLocationId: assignment.locationId,
    });
  });
}

/** `targetActor` is the same user resolved at the assignment's location. */
export async function assignPosition(
  database: Database,
  actor: Actor,
  targetActor: Actor,
  input: {
    employeeId: string;
    positionId: string;
    primaryPosition: boolean;
    effectiveFrom: string;
    expectedVersion: number;
  },
) {
  const permission = "employees.positions.manage";

  assertPermission(actor, permission);
  assertTargetAuthority(actor, targetActor, permission);

  return mapOverlap(
    () =>
      withTransaction(database, async (transaction) => {
        const employee = await lockEmployee(
          transaction,
          actor,
          input.employeeId,
        );

        assertVersion(employee, input.expectedVersion);
        assertNotTerminated(employee);
        assertNotBeforeHire(employee, input.effectiveFrom);

        const position = await findPositionInOrganization(
          transaction,
          input.positionId,
          actor.organizationId,
        );

        if (!position?.active) {
          throw new ValidationError("Choose an active position.");
        }

        const eligibility = await findActiveLocationAssignmentAt(
          transaction,
          employee.id,
          targetActor.locationId,
        );

        if (!eligibility || input.effectiveFrom < eligibility.effectiveFrom) {
          throw new BusinessRuleError(
            "LOCATION_NOT_ELIGIBLE",
            "The employee isn't eligible for this location on that date.",
          );
        }

        if (input.primaryPosition) {
          await clearPrimaryPositionAt(
            transaction,
            employee.id,
            targetActor.locationId,
          );
        }

        const assignment = await insertPositionAssignment(transaction, {
          employeeId: employee.id,
          positionId: position.id,
          locationId: targetActor.locationId,
          primaryPosition: input.primaryPosition,
          effectiveFrom: input.effectiveFrom,
        });

        await advanceVersion(transaction, employee, input.expectedVersion);

        return assignment;
      }),
    "The employee already holds this position at this location for those dates.",
  );
}

/** The row and any compensation history are kept. */
export async function endPositionAssignment(
  database: Database,
  actor: Actor,
  input: {
    employeeId: string;
    assignmentId: string;
    effectiveTo: string;
    expectedVersion: number;
  },
): Promise<void> {
  assertPermission(actor, "employees.positions.manage");

  await withTransaction(database, async (transaction) => {
    const employee = await lockEmployee(transaction, actor, input.employeeId);

    assertVersion(employee, input.expectedVersion);
    assertNotTerminated(employee);

    const assignment = await findPositionAssignmentById(
      transaction,
      employee.id,
      input.assignmentId,
    );

    if (!assignment?.active) {
      throw new NotFoundError("position assignment");
    }

    assertEndDateAllowed({
      from: assignment.effectiveFrom,
      to: input.effectiveTo,
      today: await todayAtActorLocation(transaction, actor),
    });

    await endPositionAssignmentRow(
      transaction,
      assignment.id,
      input.effectiveTo,
    );
    await advanceVersion(transaction, employee, input.expectedVersion);
  });
}

export async function setPrimaryPosition(
  database: Database,
  actor: Actor,
  input: {
    employeeId: string;
    assignmentId: string;
    expectedVersion: number;
  },
): Promise<void> {
  assertPermission(actor, "employees.positions.manage");

  await withTransaction(database, async (transaction) => {
    const employee = await lockEmployee(transaction, actor, input.employeeId);

    assertVersion(employee, input.expectedVersion);
    assertNotTerminated(employee);

    const assignment = await findPositionAssignmentById(
      transaction,
      employee.id,
      input.assignmentId,
    );

    if (!assignment?.active) {
      throw new NotFoundError("position assignment");
    }

    await clearPrimaryPositionAt(
      transaction,
      employee.id,
      assignment.locationId,
    );
    await setPrimaryPositionRow(transaction, assignment.id);
    await advanceVersion(transaction, employee, input.expectedVersion);
  });
}
