import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { assertVersionMatched } from "@/db/helpers/versioning";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";

import { normalizeEmail } from "../email";
import {
  hashPassword,
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
} from "../password";
import {
  findRoleInOrganization,
  findRolePermissionCodes,
  findUserPermissionCodes,
  holdsActiveRole,
} from "../repositories/role-repository";
import {
  activateAssignment,
  deactivateAssignment,
  disableUserRow,
  findLinkedEmployeeStatus,
  findUserAssignmentRowsAtLocation,
  findUserInOrganization,
  findUserStatusById,
  hasAssignmentAtLocation,
  insertAssignment,
  insertUser,
  updateUserActive,
} from "../repositories/user-repository";
import type { Actor } from "../types";
import {
  assertActorHolds,
  assertNotLastOwner,
  isOwnerRole,
} from "./security-rules";

/** What leaves this module about a user. It holds no credential data. */
export type UserSummary = {
  id: string;
  email: string;
  active: boolean;
  lastLoginAt: Date | null;
  version: number;
  roles: { id: string; code: string; name: string }[];
};

export async function listUsersAtLocation(
  executor: DatabaseExecutor,
  locationId: string,
): Promise<UserSummary[]> {
  const rows = await findUserAssignmentRowsAtLocation(executor, locationId);
  const byUser = new Map<string, UserSummary>();

  for (const row of rows) {
    let user = byUser.get(row.id);

    if (!user) {
      user = {
        id: row.id,
        email: row.email,
        active: row.active,
        lastLoginAt: row.lastLoginAt,
        version: row.version,
        roles: [],
      };
      byUser.set(row.id, user);
    }

    if (row.assignmentActive) {
      user.roles.push({ id: row.roleId, code: row.roleCode, name: row.roleName });
    }
  }

  return [...byUser.values()];
}

async function assertRoleAssignable(
  executor: DatabaseExecutor,
  actor: Actor,
  roleId: string,
): Promise<void> {
  const role = await findRoleInOrganization(
    executor,
    roleId,
    actor.organizationId,
  );

  if (!role?.active) {
    throw new NotFoundError("role");
  }

  assertActorHolds(actor, await findRolePermissionCodes(executor, role.id));
}

/** Creates the account and its role at the actor's location in one transaction. */
export async function createUserWithRole(
  database: Database,
  actor: Actor,
  input: { email: string; password: string; roleId: string },
): Promise<{ id: string; email: string; version: number }> {
  if (
    input.password.length < MINIMUM_PASSWORD_LENGTH ||
    input.password.length > MAXIMUM_PASSWORD_LENGTH
  ) {
    throw new ValidationError(
      `The password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
    );
  }

  await assertRoleAssignable(database, actor, input.roleId);

  // Hashing is slow, so it happens before the transaction opens.
  const passwordHash = await hashPassword(input.password);

  try {
    return await withTransaction(database, async (transaction) => {
      const user = await insertUser(transaction, {
        email: input.email.normalize("NFKC").trim(),
        normalizedEmail: normalizeEmail(input.email),
        passwordHash,
      });

      await insertAssignment(transaction, {
        userId: user.id,
        roleId: input.roleId,
        locationId: actor.locationId,
        assignedByUserId: actor.userId,
      });

      return user;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "EMAIL_ALREADY_EXISTS",
        "An account with this email already exists.",
      );
    }

    throw error;
  }
}

export async function setUserActive(
  database: Database,
  actor: Actor,
  input: { userId: string; active: boolean; expectedVersion: number },
): Promise<{ id: string; active: boolean; version: number }> {
  if (!input.active && input.userId === actor.userId) {
    throw new BusinessRuleError(
      "SELF_DISABLE_NOT_ALLOWED",
      "You can't disable your own account.",
    );
  }

  return withTransaction(database, async (transaction) => {
    if (
      !(await hasAssignmentAtLocation(
        transaction,
        input.userId,
        actor.locationId,
      ))
    ) {
      throw new NotFoundError("user");
    }

    assertActorHolds(
      actor,
      await findUserPermissionCodes(transaction, input.userId),
    );

    if (!input.active) {
      await assertNotLastOwner(transaction, {
        organizationId: actor.organizationId,
        userId: input.userId,
      });
    } else if (
      (await findLinkedEmployeeStatus(transaction, input.userId)) === "TERMINATED"
    ) {
      throw new BusinessRuleError(
        "USER_LINKED_TO_TERMINATED_EMPLOYEE",
        "This account belongs to a terminated employee. Unlink it first.",
      );
    }

    return assertVersionMatched(await updateUserActive(transaction, input), {
      type: "user",
      id: input.userId,
    });
  });
}

/**
 * Disables a terminated employee's account, in the caller's transaction, under the same
 * safeguards as disabling it directly. Any failure rolls the termination back, so an
 * employee is never terminated while keeping access through this path.
 */
export async function disableUserForTermination(
  transaction: DatabaseTransaction,
  actor: Actor,
  userId: string,
): Promise<void> {
  if (userId === actor.userId) {
    throw new BusinessRuleError(
      "SELF_TERMINATION_NOT_ALLOWED",
      "You can't terminate your own employee record.",
    );
  }

  const user = await findUserStatusById(transaction, userId);

  if (!user?.active) {
    return;
  }

  assertActorHolds(actor, await findUserPermissionCodes(transaction, userId));
  await assertNotLastOwner(transaction, {
    organizationId: actor.organizationId,
    userId,
  });
  await disableUserRow(transaction, userId);
}

/** What the Employees domain may know about a user it is linking. */
export function findLinkableUser(
  executor: DatabaseExecutor,
  userId: string,
  organizationId: string,
): Promise<{ id: string; email: string } | undefined> {
  return findUserInOrganization(executor, userId, organizationId);
}

export async function assignRole(
  database: Database,
  actor: Actor,
  input: { userId: string; roleId: string },
): Promise<void> {
  await withTransaction(database, async (transaction) => {
    await assertRoleAssignable(transaction, actor, input.roleId);

    if (!(await findUserStatusById(transaction, input.userId))) {
      throw new NotFoundError("user");
    }

    await activateAssignment(transaction, {
      userId: input.userId,
      roleId: input.roleId,
      locationId: actor.locationId,
      assignedByUserId: actor.userId,
    });
  });
}

/** Deactivates the assignment at the actor's location. The row is kept. */
export async function removeRole(
  database: Database,
  actor: Actor,
  input: { userId: string; roleId: string },
): Promise<void> {
  await withTransaction(database, async (transaction) => {
    const role = await findRoleInOrganization(
      transaction,
      input.roleId,
      actor.organizationId,
    );
    const key = { ...input, locationId: actor.locationId };

    if (!role || !(await holdsActiveRole(transaction, key))) {
      throw new NotFoundError("role assignment");
    }

    assertActorHolds(actor, await findRolePermissionCodes(transaction, role.id));

    if (isOwnerRole(role)) {
      await assertNotLastOwner(transaction, {
        organizationId: actor.organizationId,
        userId: input.userId,
        locationId: actor.locationId,
      });
    }

    await deactivateAssignment(transaction, key);
  });
}
