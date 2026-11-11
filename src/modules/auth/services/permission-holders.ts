import { and, asc, eq } from "drizzle-orm";

import { locations, permissions, rolePermissions, roles, userRoles, users } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

import type { PermissionCode } from "../permission-catalog";

/**
 * Active users who hold a permission at one location, through an active assignment of an
 * active role, in user ID order. The same rules `findEffectiveGrants` applies to one user, so
 * someone listed here is someone whose requests would be authorized. Used to address in-app
 * notifications (Phase 19 low-stock alerts); it grants nothing.
 */
export async function findUserIdsHolding(
  executor: DatabaseExecutor,
  input: { organizationId: string; locationId: string; permission: PermissionCode },
): Promise<string[]> {
  const rows = await executor
    .selectDistinct({ userId: users.id })
    .from(userRoles)
    .innerJoin(users, and(eq(users.id, userRoles.userId), eq(users.active, true)))
    .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.active, true)))
    .innerJoin(
      locations,
      and(
        eq(locations.id, userRoles.locationId),
        eq(locations.organizationId, roles.organizationId),
        eq(locations.active, true),
      ),
    )
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(permissions, and(eq(permissions.id, rolePermissions.permissionId), eq(permissions.code, input.permission)))
    .where(
      and(
        eq(userRoles.active, true),
        eq(userRoles.locationId, input.locationId),
        eq(roles.organizationId, input.organizationId),
      ),
    )
    .orderBy(asc(users.id));

  return rows.map((row) => row.userId);
}
