import { and, asc, eq } from "drizzle-orm";

import {
  locations,
  organizations,
  permissions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

export async function findUserIdentity(
  executor: DatabaseExecutor,
  userId: string,
) {
  const [user] = await executor
    .select({ id: users.id, email: users.email, active: users.active })
    .from(users)
    .where(eq(users.id, userId));

  return user;
}

/**
 * One row per granted permission. Only active assignments, roles, locations and
 * organizations count. A role with no permissions still yields a row with a null code,
 * so the location stays visible to the user.
 */
export function findEffectiveGrants(
  executor: DatabaseExecutor,
  userId: string,
) {
  return executor
    .select({
      locationId: locations.id,
      locationCode: locations.locationCode,
      locationName: locations.name,
      organizationId: locations.organizationId,
      roleId: roles.id,
      roleCode: roles.code,
      roleName: roles.name,
      permissionCode: permissions.code,
    })
    .from(userRoles)
    .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.active, true)))
    .innerJoin(
      locations,
      and(
        eq(locations.id, userRoles.locationId),
        eq(locations.organizationId, roles.organizationId),
        eq(locations.active, true),
      ),
    )
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, locations.organizationId),
        eq(organizations.active, true),
      ),
    )
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(eq(userRoles.userId, userId), eq(userRoles.active, true)))
    .orderBy(asc(locations.locationCode), asc(roles.code));
}
