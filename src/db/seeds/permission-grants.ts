import { and, eq, inArray } from "drizzle-orm";

import type { DatabaseTransaction } from "../transactions/transaction-context";
import {
  PERMISSION_CATALOG,
  type PermissionCode,
} from "../../modules/auth/permission-catalog";
import { ROLE_CATALOG } from "../../modules/auth/role-catalog";
import { permissions, rolePermissions, roles } from "../schema";

/**
 * Adds the given catalog codes and grants them to the system roles whose catalog entry holds
 * them. Upgrades an older database, and on a fresh one finds everything already in place.
 * Only these codes are granted, so a grant an administrator removed from another code stays
 * removed. Idempotent.
 */
export async function seedPermissionCodes(
  transaction: DatabaseTransaction,
  codes: readonly PermissionCode[],
): Promise<void> {
  await transaction
    .insert(permissions)
    .values(
      PERMISSION_CATALOG.filter((permission) => codes.includes(permission.code)).map(
        (permission) => ({ ...permission }),
      ),
    )
    .onConflictDoNothing({ target: permissions.code });

  const permissionRows = await transaction
    .select({ id: permissions.id, code: permissions.code })
    .from(permissions)
    .where(inArray(permissions.code, [...codes]));
  const permissionIds = new Map(permissionRows.map((row) => [row.code, row.id]));

  for (const definition of ROLE_CATALOG) {
    const grants = definition.permissions
      .filter((code) => codes.includes(code))
      .flatMap((code) => {
        const permissionId = permissionIds.get(code);

        return permissionId ? [permissionId] : [];
      });

    if (grants.length === 0) {
      continue;
    }

    const roleRows = await transaction
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.code, definition.code), eq(roles.systemRole, true)));

    for (const role of roleRows) {
      await transaction
        .insert(rolePermissions)
        .values(grants.map((permissionId) => ({ roleId: role.id, permissionId })))
        .onConflictDoNothing();
    }
  }
}
