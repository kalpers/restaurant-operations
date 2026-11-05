import { and, asc, countDistinct, eq, inArray, ne, or } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import {
  locations,
  permissions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

export async function findRoleInOrganization(
  executor: DatabaseExecutor,
  roleId: string,
  organizationId: string,
) {
  const [role] = await executor
    .select({
      id: roles.id,
      code: roles.code,
      systemRole: roles.systemRole,
      active: roles.active,
    })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)));

  return role;
}

export async function findRoleIdByCode(
  executor: DatabaseExecutor,
  organizationId: string,
  code: string,
  options: { lock?: boolean } = {},
): Promise<string | undefined> {
  const query = executor
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.organizationId, organizationId), eq(roles.code, code)));
  const [role] = await (options.lock ? query.for("update") : query);

  return role?.id;
}

export async function findRolePermissionCodes(
  executor: DatabaseExecutor,
  roleId: string,
): Promise<string[]> {
  const rows = await executor
    .select({ code: permissions.code })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(rolePermissions.roleId, roleId));

  return rows.map((row) => row.code);
}

/** Everything a user's role assignments carry, across all locations. */
export async function findUserPermissionCodes(
  executor: DatabaseExecutor,
  userId: string,
): Promise<string[]> {
  const rows = await executor
    .selectDistinct({ code: permissions.code })
    .from(userRoles)
    .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.active, true)))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(eq(userRoles.userId, userId), eq(userRoles.active, true)));

  return rows.map((row) => row.code);
}

export function findRoleRowsWithPermissions(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .select({
      id: roles.id,
      code: roles.code,
      name: roles.name,
      description: roles.description,
      systemRole: roles.systemRole,
      active: roles.active,
      version: roles.version,
      permissionCode: permissions.code,
    })
    .from(roles)
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(roles.organizationId, organizationId))
    .orderBy(asc(roles.name), asc(permissions.code));
}

export function findAllPermissions(executor: DatabaseExecutor) {
  return executor
    .select({
      code: permissions.code,
      name: permissions.name,
      description: permissions.description,
      category: permissions.category,
    })
    .from(permissions)
    .orderBy(asc(permissions.category), asc(permissions.code));
}

export function findPermissionsByCodes(
  executor: DatabaseExecutor,
  codes: readonly string[],
) {
  return executor
    .select({ id: permissions.id, code: permissions.code })
    .from(permissions)
    .where(inArray(permissions.code, [...codes]));
}

export async function insertRole(
  executor: DatabaseExecutor,
  values: {
    organizationId: string;
    code: string;
    name: string;
    description: string | null;
  },
) {
  const [role] = await executor
    .insert(roles)
    .values(values)
    .returning({ id: roles.id, version: roles.version });

  if (!role) {
    throw new Error("Role insert returned no row.");
  }

  return role;
}

/** Returns no rows when the version is stale. */
export function updateRoleActive(
  executor: DatabaseExecutor,
  input: { roleId: string; active: boolean; expectedVersion: number },
) {
  return executor
    .update(roles)
    .set({ active: input.active, version: nextVersion(roles.version) })
    .where(
      and(eq(roles.id, input.roleId), eq(roles.version, input.expectedVersion)),
    )
    .returning({ id: roles.id, active: roles.active, version: roles.version });
}

/** Returns no rows when the version is stale. */
export function bumpRoleVersion(
  executor: DatabaseExecutor,
  roleId: string,
  expectedVersion: number,
) {
  return executor
    .update(roles)
    .set({ version: nextVersion(roles.version) })
    .where(and(eq(roles.id, roleId), eq(roles.version, expectedVersion)))
    .returning({ id: roles.id, version: roles.version });
}

/** Call within a transaction, so the role is never seen with a partial set. */
export async function replacePermissionRows(
  executor: DatabaseExecutor,
  roleId: string,
  permissionIds: readonly string[],
): Promise<void> {
  await executor
    .delete(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));

  if (permissionIds.length > 0) {
    await executor
      .insert(rolePermissions)
      .values(permissionIds.map((permissionId) => ({ roleId, permissionId })));
  }
}

/** Whether the user holds the role, at one location if given, otherwise anywhere. */
export async function holdsActiveRole(
  executor: DatabaseExecutor,
  key: { roleId: string; userId: string; locationId?: string },
): Promise<boolean> {
  const rows = await executor
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.roleId, key.roleId),
        eq(userRoles.userId, key.userId),
        eq(userRoles.active, true),
        key.locationId ? eq(userRoles.locationId, key.locationId) : undefined,
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * Counts active users who would still hold the role at an active location without the
 * excluded assignment, or without any of the user's if no location is given.
 */
export async function countOtherActiveHolders(
  executor: DatabaseExecutor,
  key: { roleId: string; userId: string; locationId?: string },
): Promise<number> {
  const [result] = await executor
    .select({ total: countDistinct(userRoles.userId) })
    .from(userRoles)
    .innerJoin(users, and(eq(users.id, userRoles.userId), eq(users.active, true)))
    .innerJoin(
      locations,
      and(eq(locations.id, userRoles.locationId), eq(locations.active, true)),
    )
    .where(
      and(
        eq(userRoles.roleId, key.roleId),
        eq(userRoles.active, true),
        key.locationId
          ? or(
              ne(userRoles.userId, key.userId),
              ne(userRoles.locationId, key.locationId),
            )
          : ne(userRoles.userId, key.userId),
      ),
    );

  return result?.total ?? 0;
}
