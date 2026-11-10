import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { assertVersionMatched } from "@/db/helpers/versioning";
import {
  withTransaction,
  type DatabaseExecutor,
} from "@/db/transactions/transaction-context";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";
import { recordAudit } from "@/modules/auditing";

import {
  bumpRoleVersion,
  findAllPermissions,
  findPermissionsByCodes,
  findRoleInOrganization,
  findRolePermissionCodes,
  findRoleRowsWithPermissions,
  insertRole,
  replacePermissionRows,
  updateRoleActive,
} from "../repositories/role-repository";
import type { Actor } from "../types";
import { assertActorHolds, isOwnerRole } from "./security-rules";

export type RoleSummary = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  systemRole: boolean;
  active: boolean;
  version: number;
  permissions: string[];
};

export async function listRoles(
  executor: DatabaseExecutor,
  organizationId: string,
): Promise<RoleSummary[]> {
  const rows = await findRoleRowsWithPermissions(executor, organizationId);
  const byRole = new Map<string, RoleSummary>();

  for (const { permissionCode, ...role } of rows) {
    const summary = byRole.get(role.id) ?? { ...role, permissions: [] };

    if (permissionCode) {
      summary.permissions.push(permissionCode);
    }

    byRole.set(role.id, summary);
  }

  return [...byRole.values()];
}

export function listPermissions(executor: DatabaseExecutor) {
  return findAllPermissions(executor);
}

async function findEditableRole(
  executor: DatabaseExecutor,
  actor: Actor,
  roleId: string,
) {
  const role = await findRoleInOrganization(
    executor,
    roleId,
    actor.organizationId,
  );

  if (!role) {
    throw new NotFoundError("role");
  }

  if (isOwnerRole(role)) {
    throw new BusinessRuleError(
      "ROLE_IMMUTABLE",
      "The Owner role always has every permission and can't be changed.",
    );
  }

  return role;
}

/** A new role starts with no permissions. */
export async function createRole(
  database: Database,
  actor: Actor,
  input: { code: string; name: string; description: string | null },
): Promise<{ id: string; version: number }> {
  try {
    return await withTransaction(database, async (transaction) => {
      const role = await insertRole(transaction, {
        ...input,
        organizationId: actor.organizationId,
      });

      await recordAudit(transaction, actor, {
        action: "admin.role-created",
        entityId: role.id,
        after: { roleCode: input.code, roleName: input.name, permissionCodes: [] },
      });

      return role;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "ROLE_CODE_EXISTS",
        "A role with this code already exists.",
      );
    }

    throw error;
  }
}

export async function setRoleActive(
  database: Database,
  actor: Actor,
  input: { roleId: string; active: boolean; expectedVersion: number },
): Promise<{ id: string; active: boolean; version: number }> {
  return withTransaction(database, async (transaction) => {
    const role = await findEditableRole(transaction, actor, input.roleId);

    if (role.systemRole) {
      throw new BusinessRuleError(
        "SYSTEM_ROLE_REQUIRED",
        "System roles can't be deactivated.",
      );
    }

    assertActorHolds(actor, await findRolePermissionCodes(transaction, role.id));

    const result = assertVersionMatched(await updateRoleActive(transaction, input), {
      type: "role",
      id: role.id,
    });

    await recordAudit(transaction, actor, {
      action: input.active ? "admin.role-activated" : "admin.role-deactivated",
      entityId: role.id,
      before: { roleCode: role.code, active: role.active },
      after: { roleCode: role.code, active: result.active },
    });

    return result;
  });
}

/** Replaces the whole permission set atomically. Takes effect on the next request. */
export async function replaceRolePermissions(
  database: Database,
  actor: Actor,
  input: { roleId: string; permissions: string[]; expectedVersion: number },
): Promise<{ id: string; version: number }> {
  return withTransaction(database, async (transaction) => {
    const role = await findEditableRole(transaction, actor, input.roleId);
    const requested = new Set(input.permissions);
    const known = await findPermissionsByCodes(transaction, [...requested]);

    if (known.length !== requested.size) {
      throw new ValidationError("The request includes an unknown permission.");
    }

    const current = new Set(await findRolePermissionCodes(transaction, role.id));

    const added = [...requested].filter((code) => !current.has(code)).sort();
    const removed = [...current].filter((code) => !requested.has(code)).sort();

    assertActorHolds(actor, [...added, ...removed]);

    const result = assertVersionMatched(
      await bumpRoleVersion(transaction, role.id, input.expectedVersion),
      { type: "role", id: role.id },
    );

    await replacePermissionRows(
      transaction,
      role.id,
      known.map((permission) => permission.id),
    );

    await recordAudit(transaction, actor, {
      action: "admin.role-permissions-replaced",
      entityId: role.id,
      details: { roleCode: role.code, added, removed },
    });

    return result;
  });
}
